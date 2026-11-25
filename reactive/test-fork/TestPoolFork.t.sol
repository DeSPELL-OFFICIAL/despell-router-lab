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
import {LaunchSecondPool} from "../script/LaunchSecondPool.s.sol";
import {Quote} from "../script/Quote.s.sol";
import {Seed} from "../script/Seed.s.sol";
import {SetFee} from "../script/SetFee.s.sol";
import {TestPoolScript} from "../script/TestPoolScript.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";

/// @dev Seeds a pool from this contract's own ETH, with the scripts' seed code, so a test can seed a pool on the live
///      hook without the live owner's key (adding liquidity is open to anyone; only initializing is the owner's).
contract SeedFromHere is TestPoolScript {
    function seed(PoolKey memory key, uint256 amountWei) external returns (uint256) {
        return _seed(key, amountWei, address(this));
    }

    receive() external payable {}
}

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
        uint256 dustInPositionManager = BaseSepolia.POSITION_MANAGER.balance;
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
        // Liquidity rounds down, so the pool takes a little less than the seed; SWEEP returns that spare and any
        // ETH others left in the PositionManager. The deployer never pays more than the seed + 1 wei (gas is free here).
        uint256 spent = 1 ether + dustInPositionManager - deployer.balance;
        assertLe(spent, 0.01 ether + 1);
        assertApproxEqAbs(spent, 0.01 ether, 1e9);
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

    function _quote10(PoolKey memory key) internal returns (uint256 ethOut) {
        (ethOut,) = IV4Quoter(BaseSepolia.QUOTER)
            .quoteExactInputSingle(
                IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: false, exactAmount: 10e6, hookData: ""})
            );
    }

    function test_launchSecond_opensOnTheSameHookAtTheFirstPoolsPrice() public {
        (DynamicFeeHook hook, PoolId first) = _launch(0.04 ether);
        vm.recordLogs();
        PoolId second = new LaunchSecondPool().launchSecond(hook, 0.01 ether);

        IPoolManager manager = IPoolManager(BaseSepolia.POOL_MANAGER);
        (uint160 firstPrice,,,) = manager.getSlot0(first);
        (uint160 secondPrice,,, uint24 secondFee) = manager.getSlot0(second);
        assertEq(secondPrice, firstPrice, "starts at the first pool's price");
        assertEq(secondFee, BaseSepolia.INITIAL_FEE);
        assertEq(hook.feeOf(second), BaseSepolia.INITIAL_FEE);

        // The FeeUpdated(0 -> 500) that PoolReflex turns into "narrowed" for a new pool.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawInitialFee;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == DynamicFeeHook.FeeUpdated.selector) {
                assertEq(logs[i].topics[1], PoolId.unwrap(second));
                sawInitialFee = true;
            }
        }
        assertTrue(sawInitialFee, "FeeUpdated for the second pool at initialize");

        uint256 firstOut = _quote10(BaseSepolia.poolKey(hook));
        uint256 secondOut = _quote10(BaseSepolia.poolKey(hook, BaseSepolia.SECOND_TICK_SPACING));
        assertGt(secondOut, 0, "the second pool fills 10 USDC");
        assertLt(secondOut, firstOut, "less liquidity, so the first pool pays more while both are open");

        LaunchSecondPool again = new LaunchSecondPool();
        vm.expectRevert("second pool already initialized");
        again.launchSecond(hook, 0.01 ether);
    }

    function test_setFee_tickSpacingPicksThePool() public {
        (DynamicFeeHook hook, PoolId first) = _launch(0.04 ether);
        PoolId second = new LaunchSecondPool().launchSecond(hook, 0.01 ether);

        (uint24 oldFee, uint24 newFee) = new SetFee().setFee(hook, 3000, BaseSepolia.SECOND_TICK_SPACING);
        assertEq(oldFee, 500);
        assertEq(newFee, 3000);
        assertEq(hook.feeOf(second), 3000);
        assertEq(hook.feeOf(first), 500, "the first pool keeps its fee");

        SetFee setFee = new SetFee();
        vm.expectRevert("TICK_SPACING must be 10 (first pool) or 60 (second pool)");
        setFee.setFee(hook, 3000, 30);
    }

    /// @notice Pool B on the live hook beside the live pool A: opened at A's price (rehearsed here with the live owner
    ///         until the real launch, read as it is after), and while both are open A pays more for 10 USDC.
    function test_live_secondPoolOnTheLiveHookQuotesBelowTheFirst() public {
        IHooks live = IHooks(vm.parseJsonAddress(vm.readFile("deployments/base-sepolia.json"), ".hook"));
        PoolKey memory firstKey = BaseSepolia.poolKey(live);
        PoolKey memory secondKey = BaseSepolia.poolKey(live, BaseSepolia.SECOND_TICK_SPACING);
        bytes32 appPoolBId = 0xa7692fed527766fb44a78fb84faffa4cc759bb29002969b87e571366db28efc2;
        assertEq(PoolId.unwrap(secondKey.toId()), appPoolBId, "the second pool id the app lists");

        IPoolManager manager = IPoolManager(BaseSepolia.POOL_MANAGER);
        (uint160 secondNow,,,) = manager.getSlot0(secondKey.toId());
        if (secondNow == 0) {
            (uint160 firstPrice,,,) = manager.getSlot0(firstKey.toId());
            vm.prank(DynamicFeeHook(address(live)).owner());
            manager.initialize(secondKey, firstPrice);
            SeedFromHere seeder = new SeedFromHere();
            vm.deal(address(seeder), 1 ether);
            vm.prank(address(seeder));
            seeder.seed(secondKey, 0.01 ether);
        }

        uint256 firstOut = _quote10(firstKey);
        uint256 secondOut = _quote10(secondKey);
        emit log_named_uint("first pool, 10 USDC -> wei", firstOut);
        emit log_named_uint("second pool, 10 USDC -> wei", secondOut);
        assertGt(secondOut, 0);
        assertLt(secondOut, firstOut);
    }
}
