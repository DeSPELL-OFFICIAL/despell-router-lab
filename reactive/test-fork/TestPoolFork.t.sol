// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

import {DynamicFeeHook} from "../src/DynamicFeeHook.sol";
import {BaseSepolia} from "../script/BaseSepolia.sol";
import {Launch} from "../script/Launch.s.sol";
import {Quote} from "../script/Quote.s.sol";
import {Seed} from "../script/Seed.s.sol";
import {SetFee} from "../script/SetFee.s.sol";

/// @notice Runs the same scripts the live launch uses, on a fork of Base Sepolia, against Uniswap's real
///         PoolManager, PositionManager, StateView and V4Quoter. A throwaway key stands in for the deployer.
contract TestPoolForkTest is Test {
    using StateLibrary for IPoolManager;

    uint256 constant KEY = 0xA11CE;
    address deployer;

    function setUp() public {
        vm.createSelectFork("base_sepolia");
        deployer = vm.addr(KEY);
        vm.deal(deployer, 1 ether);
        // The same value in every test, so tests running in parallel never see each other's key.
        // Everything else goes in as function arguments: vm.setEnv is shared by the whole process.
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(KEY)));
    }

    function _launch(uint256 seedWei) internal returns (DynamicFeeHook hook, PoolId poolId) {
        return new Launch().launch(seedWei);
    }

    function _setFee(DynamicFeeHook hook, uint24 newFee) internal returns (uint24 oldFee, uint24 setTo) {
        return new SetFee().setFee(hook, newFee);
    }

    function _quote(DynamicFeeHook hook) internal returns (uint24 lpFee, uint256 ethOut) {
        return new Quote().quote(hook, 100e6);
    }

    function test_launch_deploysHookPoolAndEthOnlySeed() public {
        uint256 nextId = IPositionManager(BaseSepolia.POSITION_MANAGER).nextTokenId();
        vm.recordLogs();
        (DynamicFeeHook hook, PoolId poolId) = _launch(0.01 ether);

        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, Hooks.AFTER_INITIALIZE_FLAG, "only afterInitialize");
        assertEq(hook.owner(), deployer);
        assertEq(hook.feeOf(poolId), BaseSepolia.INITIAL_FEE);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawInitialFee;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == DynamicFeeHook.FeeUpdated.selector) {
                assertEq(logs[i].topics[1], PoolId.unwrap(poolId));
                (uint24 oldFee, uint24 newFee) = abi.decode(logs[i].data, (uint24, uint24));
                assertEq(oldFee, 0);
                assertEq(newFee, BaseSepolia.INITIAL_FEE);
                sawInitialFee = true;
            }
        }
        assertTrue(sawInitialFee, "FeeUpdated(0 -> 500) at initialize");

        IPositionManager posm = IPositionManager(BaseSepolia.POSITION_MANAGER);
        assertEq(posm.nextTokenId(), nextId + 1, "one position minted");
        assertGt(posm.getPositionLiquidity(nextId), 0);
        assertGt(IPoolManager(BaseSepolia.POOL_MANAGER).getLiquidity(poolId), 0, "seed is in range");
        // SWEEP returns the rounding spare (and any dust others left in the PositionManager), so the deployer
        // spends the seed give or take a few wei. Gas is free in this test.
        assertApproxEqAbs(1 ether - deployer.balance, 0.01 ether, 1e9);
    }

    function test_setFee_changesFeeThatStateViewAndQuoterSee() public {
        (DynamicFeeHook hook,) = _launch(0.1 ether);

        (uint24 feeBefore, uint256 ethOutLowFee) = _quote(hook);
        assertEq(feeBefore, 500);
        assertApproxEqRel(ethOutLowFee, 0.0602 ether, 0.01e18, "100 USDC -> about 0.06 ETH");

        (uint24 oldFee, uint24 newFee) = _setFee(hook, 100_000);
        assertEq(oldFee, 500);
        assertEq(newFee, 100_000);

        (uint24 feeAfter, uint256 ethOutHighFee) = _quote(hook);
        assertEq(feeAfter, 100_000);
        assertApproxEqRel(ethOutHighFee, ethOutLowFee * 900_000 / 999_500, 0.01e18, "10% fee costs about 10%");

        _setFee(hook, 500);
        (uint24 feeRestored,) = _quote(hook);
        assertEq(feeRestored, 500);
    }

    function test_seed_addsAnotherEthOnlyPosition() public {
        (DynamicFeeHook hook, PoolId poolId) = _launch(0.01 ether);
        uint128 liquidityBefore = IPoolManager(BaseSepolia.POOL_MANAGER).getLiquidity(poolId);

        uint256 tokenId = new Seed().seed(hook, 0.09 ether);

        assertGt(IPositionManager(BaseSepolia.POSITION_MANAGER).getPositionLiquidity(tokenId), 0);
        assertGt(IPoolManager(BaseSepolia.POOL_MANAGER).getLiquidity(poolId), liquidityBefore);
        (, uint256 ethOut) = _quote(hook);
        assertApproxEqRel(ethOut, 0.0602 ether, 0.01e18, "0.01 + 0.09 ETH quotes like one 0.1 ETH seed");
    }
}
