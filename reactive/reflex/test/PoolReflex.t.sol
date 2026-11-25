// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";

import {PoolGuard} from "../src/PoolGuard.sol";
import {PoolReflex} from "../src/PoolReflex.sol";
import {MockCallbackProxy, MockSystem} from "./mocks/ReactiveMocks.sol";

/// @dev One EVM stands in for both chains: MockSystem plays Reactive's system contract, MockCallbackProxy plays the
///      Base Sepolia callback proxy.
contract PoolReflexTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 constant BASE_SEPOLIA = 84532;
    address constant HOOK = 0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000;
    bytes32 constant POOL = 0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4;
    uint256 constant TOPIC0 = 0x96a011a1e8a72dbc16d5af5d8f0db6bf107a76580682a94073bb6ffec86a0872;

    address owner = makeAddr("owner");
    MockSystem system;
    MockCallbackProxy proxy;
    PoolReflex reflex;
    PoolGuard guard;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystem()).code);
        system = MockSystem(payable(SYSTEM));
        proxy = new MockCallbackProxy();
        reflex = new PoolReflex(BASE_SEPOLIA, HOOK, BASE_SEPOLIA, owner);
        guard = new PoolGuard(IPayable(payable(address(proxy))), address(reflex), owner);
        vm.prank(owner);
        reflex.setGuard(address(guard));
    }

    function _feeLog(uint24 oldFee, uint24 newFee, uint256 blockNumber, bytes32 txHash)
        internal
        pure
        returns (IReactive.LogRecord memory log_)
    {
        log_.chainId = BASE_SEPOLIA;
        log_.contractAddress = HOOK;
        log_.topic0 = TOPIC0;
        log_.topic1 = uint256(POOL);
        log_.data = abi.encode(oldFee, newFee);
        log_.blockNumber = blockNumber;
        log_.txHash = uint256(txHash);
    }

    function _react(IReactive.LogRecord memory log_) internal {
        vm.prank(SYSTEM);
        reflex.react(log_);
    }

    /// @dev Delivers the newest callback request through the proxy, as Reactive Network would.
    function _deliverLast() internal returns (bool ok) {
        uint256 n = system.requestCount();
        (ok,) = proxy.deliver(address(reflex), system.request(n - 1));
    }

    // --- subscription ---

    function test_constructor_subscribesToTheHooksFeeUpdated() public view {
        assertEq(system.subscriptionCount(), 1);
        (uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) = system.subscriptions(0);
        assertEq(c, BASE_SEPOLIA);
        assertEq(a, HOOK);
        assertEq(t0, TOPIC0);
        assertEq(t0, uint256(keccak256("FeeUpdated(bytes32,uint24,uint24)")));
        assertEq(t1, REACTIVE_IGNORE);
        assertEq(t2, REACTIVE_IGNORE);
        assertEq(t3, REACTIVE_IGNORE);
    }

    // --- react ---

    function test_react_feeChangeRequestsANarrowMark() public {
        bytes32 txHash = keccak256("fee 500 -> 100000");
        vm.expectEmit(true, true, false, true, address(reflex));
        emit PoolReflex.Reflex(POOL, "fee_changed", 2, 500, 100_000, 63_531_756, txHash);
        _react(_feeLog(500, 100_000, 63_531_756, txHash));

        assertEq(system.requestCount(), 1);
        assertEq(system.requesters(0), address(reflex));
        ISystemContract.CallbackConfiguration_V_1_0 memory c = system.request(0);
        assertEq(c.chainId, BASE_SEPOLIA);
        assertEq(c.recipient, address(guard));
        assertEq(c.gasLimit, 400_000);
        assertEq(
            c.payload,
            abi.encodeCall(PoolGuard.mark, (address(0), POOL, uint8(2), bytes32("fee_changed"), 63_531_756, txHash))
        );
    }

    function test_react_revertsUnlessTheSystemCalls() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, stranger, SYSTEM));
        reflex.react(_feeLog(500, 100_000, 1, bytes32(0)));
    }

    function test_react_ignoresOtherEventsContractsAndChains() public {
        IReactive.LogRecord memory log_ = _feeLog(500, 100_000, 1, bytes32(0));
        log_.topic0 = uint256(keccak256("Swap(bytes32)"));
        _react(log_);
        log_ = _feeLog(500, 100_000, 1, bytes32(0));
        log_.contractAddress = makeAddr("otherHook");
        _react(log_);
        log_ = _feeLog(500, 100_000, 1, bytes32(0));
        log_.chainId = 1;
        _react(log_);
        assertEq(system.requestCount(), 0);
    }

    function test_react_doesNothingBeforeTheGuardIsSet() public {
        PoolReflex fresh = new PoolReflex(BASE_SEPOLIA, HOOK, BASE_SEPOLIA, owner);
        vm.prank(SYSTEM);
        fresh.react(_feeLog(500, 100_000, 1, bytes32(0)));
        assertEq(system.requestCount(), 0);
    }

    function test_setGuard_ownerOnlyAndOnce() public {
        PoolReflex fresh = new PoolReflex(BASE_SEPOLIA, HOOK, BASE_SEPOLIA, owner);
        vm.expectRevert(PoolReflex.NotOwner.selector);
        fresh.setGuard(address(guard));
        vm.prank(owner);
        fresh.setGuard(address(guard));
        vm.prank(owner);
        vm.expectRevert(PoolReflex.GuardAlreadySet.selector);
        fresh.setGuard(makeAddr("anotherGuard"));
    }

    function test_reflexFor_matchesTheRoutersTable() public view {
        assertEq(reflex.reflexFor("code_changed"), 3);
        assertEq(reflex.reflexFor("token_code_changed"), 3);
        assertEq(reflex.reflexFor("implementation_changed"), 3);
        assertEq(reflex.reflexFor("sell_reverted"), 3);
        assertEq(reflex.reflexFor("owner_changed"), 2);
        assertEq(reflex.reflexFor("fee_changed"), 2);
        assertEq(reflex.reflexFor("reserve_below_band"), 2);
        assertEq(reflex.reflexFor("round_trip_loss_up"), 2);
        assertEq(reflex.reflexFor("paused"), 0);
        assertEq(reflex.reflexFor("stale"), 0);
    }

    // --- the whole loop, as Reactive Network would run it ---

    function test_loop_feeChangeMarksThePoolAndFlippingBackDoesNotReopenIt() public {
        // 0.05% -> 10%: the pool is narrowed.
        _react(_feeLog(500, 100_000, 10, keccak256("up")));
        assertTrue(_deliverLast(), "callback delivered");
        assertEq(guard.statusOf(POOL), 2);

        // 10% -> 0.05%: flipping the setting back is another change, and marks never loosen.
        _react(_feeLog(100_000, 500, 11, keccak256("back")));
        assertTrue(_deliverLast());
        assertEq(guard.statusOf(POOL), 2, "still narrowed");
        assertEq(guard.markOf(POOL).originTx, keccak256("up"), "the first change stays on record");

        // Only the owner reopens; the next change narrows it again.
        vm.prank(owner);
        guard.reopen(POOL);
        assertEq(guard.statusOf(POOL), 0);
        _react(_feeLog(500, 100_000, 12, keccak256("again")));
        assertTrue(_deliverLast());
        assertEq(guard.statusOf(POOL), 2);
    }

    function test_loop_aNewPoolStartsNarrowedUntilTheOwnerReopensIt() public {
        bytes32 newPool = keccak256("a second pool on the hook");
        IReactive.LogRecord memory log_ = _feeLog(0, 500, 20, keccak256("initialize"));
        log_.topic1 = uint256(newPool);
        _react(log_);
        assertTrue(_deliverLast());
        assertEq(guard.statusOf(newPool), 2, "fails closed: untested pools are not open");
        vm.prank(owner);
        guard.reopen(newPool);
        assertEq(guard.statusOf(newPool), 0);
    }

    function test_loop_aForgedCallbackFromAnotherReactiveContractIsRefused() public {
        _react(_feeLog(500, 100_000, 10, keccak256("up")));
        (bool ok,) = proxy.deliver(makeAddr("someoneElsesReactive"), system.request(0));
        assertFalse(ok, "proxy call reverts inside PoolGuard");
        assertEq(guard.statusOf(POOL), 0);
    }

    function test_loop_markFitsTheCallbackGas() public {
        _react(_feeLog(500, 100_000, 10, keccak256("up")));
        ISystemContract.CallbackConfiguration_V_1_0 memory c = system.request(0);
        uint256 before = gasleft();
        proxy.deliver(address(reflex), c);
        uint256 used = before - gasleft();
        assertLt(used, c.gasLimit - 130_000, "mark runs well inside what the proxy forwards");
    }
}
