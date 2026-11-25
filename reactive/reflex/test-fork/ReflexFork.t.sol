// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

import {PoolGuard} from "../src/PoolGuard.sol";
import {PoolReflex} from "../src/PoolReflex.sol";
import {MockSystem} from "../test/mocks/ReactiveMocks.sol";

/// @dev The v4 PoolKey, with Currency and IHooks as plain addresses (same ABI).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IDynamicFeeHook {
    function owner() external view returns (address);
    function feeOf(bytes32 poolId) external view returns (uint24);
    function setFee(PoolKey calldata key, uint24 newFee) external;
}

/// @notice The test pool's real hook on a Base Sepolia fork, with Reactive's real callback proxy address.
contract BaseSepoliaReflexForkTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    address constant CALLBACK_PROXY = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
    address constant HOOK = 0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    bytes32 constant POOL = 0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4;

    IDynamicFeeHook hook = IDynamicFeeHook(HOOK);
    PoolKey key = PoolKey(address(0), USDC, 0x800000, 10, HOOK);
    MockSystem system;
    PoolReflex reflex;
    PoolGuard guard;
    address owner = makeAddr("guardOwner");

    function setUp() public {
        vm.createSelectFork("base_sepolia");
        // PoolReflex lives on Reactive Network; here it runs next to the hook with a stand-in system contract.
        vm.etch(SYSTEM, address(new MockSystem()).code);
        system = MockSystem(payable(SYSTEM));
        reflex = new PoolReflex(block.chainid, HOOK, block.chainid, owner);
        guard = new PoolGuard(IPayable(payable(CALLBACK_PROXY)), address(reflex), owner);
        vm.prank(owner);
        reflex.setGuard(address(guard));
    }

    /// @dev Changes the real pool's fee as its owner and returns the FeeUpdated log as Reactive would see it.
    function _changeFee(uint24 newFee, bytes32 txHash) internal returns (IReactive.LogRecord memory log_) {
        vm.recordLogs();
        vm.prank(hook.owner());
        hook.setFee(key, newFee);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one event per fee change");
        log_.chainId = block.chainid;
        log_.contractAddress = logs[0].emitter;
        log_.topic0 = uint256(logs[0].topics[0]);
        log_.topic1 = uint256(logs[0].topics[1]);
        log_.data = logs[0].data;
        log_.blockNumber = block.number;
        log_.txHash = uint256(txHash);
    }

    /// @dev Reactive Network's part: react, then the proxy calls PoolGuard with its first argument replaced.
    function _reactAndDeliver(IReactive.LogRecord memory log_) internal {
        uint256 before = system.requestCount();
        vm.prank(SYSTEM);
        reflex.react(log_);
        assertEq(system.requestCount(), before + 1, "callback requested");
        ISystemContract.CallbackConfiguration_V_1_0 memory c = system.request(before);
        bytes memory payload = c.payload;
        address sender = address(reflex);
        assembly {
            mstore(add(payload, 36), sender)
        }
        vm.prank(CALLBACK_PROXY);
        (bool ok,) = c.recipient.call{gas: c.gasLimit - 130_000}(payload);
        assertTrue(ok, "mark succeeded");
    }

    function test_realFeeChange_marksThePool_andFlippingBackKeepsTheMark() public {
        assertEq(hook.feeOf(POOL), 500, "the pool rests at 0.05%");

        _reactAndDeliver(_changeFee(100_000, keccak256("up")));
        assertEq(guard.statusOf(POOL), 2, "narrowed after 0.05% -> 10%");

        _reactAndDeliver(_changeFee(500, keccak256("back")));
        assertEq(hook.feeOf(POOL), 500);
        assertEq(guard.statusOf(POOL), 2, "still narrowed after the fee went back");

        vm.prank(owner);
        guard.reopen(POOL);
        assertEq(guard.statusOf(POOL), 0);
    }

    function test_realProxy_tracksGuardDebt() public view {
        assertEq(IPayable(payable(CALLBACK_PROXY)).debt(address(guard)), 0);
    }
}

/// @notice PoolReflex against Reactive Lasna's real system contract: the subscription and callback request calls
///         must match what the network accepts.
contract LasnaReflexForkTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    address constant HOOK = 0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000;
    bytes32 constant POOL = 0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4;
    uint256 constant TOPIC0 = 0x96a011a1e8a72dbc16d5af5d8f0db6bf107a76580682a94073bb6ffec86a0872;
    uint256 constant BASE_SEPOLIA = 84532;
    bytes32 constant CALLBACK_REQUEST = keccak256("CallbackRequest(uint256,address,address,uint8,bytes)");

    function test_deployAndReact_onTheRealSystemContract() public {
        vm.createSelectFork("lasna");
        assertEq(block.chainid, 5318007);
        address owner = makeAddr("owner");
        vm.deal(owner, 1 ether);

        vm.prank(owner);
        PoolReflex reflex = new PoolReflex{value: 0.1 ether}(BASE_SEPOLIA, HOOK, BASE_SEPOLIA, owner);
        address guard = makeAddr("guardOnBaseSepolia");
        vm.prank(owner);
        reflex.setGuard(guard);

        IReactive.LogRecord memory log_;
        log_.chainId = BASE_SEPOLIA;
        log_.contractAddress = HOOK;
        log_.topic0 = TOPIC0;
        log_.topic1 = uint256(POOL);
        log_.data = abi.encode(uint24(500), uint24(100_000));
        log_.blockNumber = 63_531_756;
        log_.txHash = 0xb96244b8cd9fc54ac2b4c852c0f912e94ea4ba4cbb1a79259c857e85ceb8d474;

        vm.recordLogs();
        vm.prank(SYSTEM);
        reflex.react(log_);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawReflex;
        bool sawCallback;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(reflex) && logs[i].topics[0] == PoolReflex.Reflex.selector) {
                sawReflex = true;
            }
            // The system contract records the request as CallbackRequest(chainId, sender, recipient, version, config)
            // (read off the live contract), and Reactive Network delivers it to the destination chain.
            if (logs[i].emitter == SYSTEM && logs[i].topics[0] == CALLBACK_REQUEST) {
                assertEq(uint256(logs[i].topics[1]), BASE_SEPOLIA);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(reflex));
                assertEq(address(uint160(uint256(logs[i].topics[3]))), guard);
                (uint8 version, bytes memory config) = abi.decode(logs[i].data, (uint8, bytes));
                assertEq(version, uint8(ISystemContract.CallbackVersion.V_1_0));
                ISystemContract.CallbackConfiguration_V_1_0 memory c =
                    abi.decode(config, (ISystemContract.CallbackConfiguration_V_1_0));
                assertEq(c.chainId, BASE_SEPOLIA);
                assertEq(c.recipient, guard);
                assertEq(c.gasLimit, 400_000);
                assertEq(
                    c.payload,
                    abi.encodeCall(
                        PoolGuard.mark,
                        (address(0), POOL, uint8(2), bytes32("fee_changed"), log_.blockNumber, bytes32(log_.txHash))
                    )
                );
                sawCallback = true;
            }
        }
        assertTrue(sawReflex, "react finished");
        assertTrue(sawCallback, "the real system contract accepted requestCallbackV_1_0");
    }
}
