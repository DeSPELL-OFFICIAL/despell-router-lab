// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {Pool} from "v4-core/src/libraries/Pool.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {DynamicFeeHook} from "../src/DynamicFeeHook.sol";
import {BaseSepolia} from "../script/BaseSepolia.sol";

contract DynamicFeeHookTest is Deployers {
    using StateLibrary for IPoolManager;

    uint24 constant INITIAL_FEE = 500; // 0.05%
    uint24 constant HIGH_FEE = 100_000; // 10%
    uint160 constant FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG);

    DynamicFeeHook hook;
    PoolId poolId;
    address stranger = makeAddr("stranger");

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = _deployHookAt(address(uint160(0x4444) << 144 | FLAGS), address(this));
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        poolId = key.toId();
    }

    function _deployHookAt(address target, address owner_) internal returns (DynamicFeeHook) {
        deployCodeTo("DynamicFeeHook.sol:DynamicFeeHook", abi.encode(manager, owner_, INITIAL_FEE), target);
        return DynamicFeeHook(target);
    }

    function _wrappedHookError(bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.afterInitialize.selector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _lpFee() internal view returns (uint24 lpFee) {
        (,,, lpFee) = manager.getSlot0(poolId);
    }

    // --- deployment ---

    function test_permissions_onlyAfterInitialize() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterInitialize);
        assertFalse(p.beforeInitialize || p.beforeSwap || p.afterSwap || p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity || p.beforeRemoveLiquidity || p.afterRemoveLiquidity);
        assertFalse(p.beforeDonate || p.afterDonate || p.beforeSwapReturnDelta || p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta);
        assertEq(hook.owner(), address(this));
        assertEq(hook.initialFee(), INITIAL_FEE);
    }

    function test_constructor_revertsAtAddressWithoutTheFlag() public {
        address plain = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        assertTrue(uint160(plain) & Hooks.ALL_HOOK_MASK != FLAGS, "test needs an unflagged address");
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, plain));
        new DynamicFeeHook(manager, address(this), INITIAL_FEE);
    }

    function test_constructor_revertsForZeroOwner() public {
        vm.expectRevert(DynamicFeeHook.ZeroOwner.selector);
        _deployHookAt(address(uint160(0x5555) << 144 | FLAGS), address(0));
    }

    function test_constructor_revertsForFeeAboveMax() public {
        address target = address(uint160(0x6666) << 144 | FLAGS);
        vm.expectRevert(abi.encodeWithSelector(LPFeeLibrary.LPFeeTooLarge.selector, uint24(1_000_001)));
        deployCodeTo("DynamicFeeHook.sol:DynamicFeeHook", abi.encode(manager, address(this), uint24(1_000_001)), target);
    }

    // --- initialize ---

    function test_initialize_setsInitialFeeAndEmits() public {
        vm.expectEmit(true, false, false, true, address(hook));
        emit DynamicFeeHook.FeeUpdated(poolId, 0, INITIAL_FEE);
        manager.initialize(key, SQRT_PRICE_1_1);

        assertEq(_lpFee(), INITIAL_FEE);
        assertEq(hook.feeOf(poolId), INITIAL_FEE);
    }

    function test_initialize_revertsWhenStrangerCreatesPool() public {
        vm.prank(stranger);
        vm.expectRevert(_wrappedHookError(abi.encodeWithSelector(DynamicFeeHook.NotOwner.selector)));
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    function test_initialize_revertsForStaticFeePool() public {
        PoolKey memory staticKey = key;
        staticKey.fee = 500;
        vm.expectRevert(_wrappedHookError(abi.encodeWithSelector(DynamicFeeHook.NotDynamicFee.selector)));
        manager.initialize(staticKey, SQRT_PRICE_1_1);
    }

    // --- setFee ---

    function test_setFee_updatesFeeAndEmitsOldAndNew() public {
        manager.initialize(key, SQRT_PRICE_1_1);

        vm.expectEmit(true, false, false, true, address(hook));
        emit DynamicFeeHook.FeeUpdated(poolId, INITIAL_FEE, HIGH_FEE);
        hook.setFee(key, HIGH_FEE);

        assertEq(_lpFee(), HIGH_FEE);
        assertEq(hook.feeOf(poolId), HIGH_FEE);
    }

    function test_setFee_backAndForthEmitsEveryChange() public {
        manager.initialize(key, SQRT_PRICE_1_1);

        vm.expectEmit(true, false, false, true, address(hook));
        emit DynamicFeeHook.FeeUpdated(poolId, INITIAL_FEE, HIGH_FEE);
        hook.setFee(key, HIGH_FEE);

        vm.expectEmit(true, false, false, true, address(hook));
        emit DynamicFeeHook.FeeUpdated(poolId, HIGH_FEE, INITIAL_FEE);
        hook.setFee(key, INITIAL_FEE);

        assertEq(_lpFee(), INITIAL_FEE);
    }

    function test_setFee_emitsExactlyOneEvent() public {
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.recordLogs();
        hook.setFee(key, HIGH_FEE);
        assertEq(vm.getRecordedLogs().length, 1, "the PoolManager emits nothing for a dynamic fee change");
    }

    function test_setFee_changesWhatASwapPays() public {
        manager.initialize(key, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);
        int256 amountIn = -1e14;

        uint256 snapshot = vm.snapshotState();
        uint256 outLowFee = uint256(int256(swap(key, true, amountIn, ZERO_BYTES).amount1()));
        vm.revertToState(snapshot);

        hook.setFee(key, HIGH_FEE);
        uint256 outHighFee = uint256(int256(swap(key, true, amountIn, ZERO_BYTES).amount1()));

        // Same input, 10% fee instead of 0.05%: the output drops by about (1 - 0.10) / (1 - 0.0005).
        assertLt(outHighFee, outLowFee);
        assertApproxEqRel(outHighFee, outLowFee * 900_000 / 999_500, 0.005e18);
    }

    function test_setFee_revertsForStranger() public {
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.prank(stranger);
        vm.expectRevert(DynamicFeeHook.NotOwner.selector);
        hook.setFee(key, HIGH_FEE);
    }

    function test_setFee_revertsWhenUnchanged() public {
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.expectRevert(abi.encodeWithSelector(DynamicFeeHook.FeeUnchanged.selector, INITIAL_FEE));
        hook.setFee(key, INITIAL_FEE);
    }

    function test_setFee_revertsAboveMax() public {
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.expectRevert(abi.encodeWithSelector(LPFeeLibrary.LPFeeTooLarge.selector, uint24(1_000_001)));
        hook.setFee(key, 1_000_001);
    }

    function test_setFee_revertsForKeyOfAnotherHook() public {
        PoolKey memory other = key;
        other.hooks = IHooks(address(0xBEEF));
        vm.expectRevert(BaseHook.InvalidPool.selector);
        hook.setFee(other, HIGH_FEE);
    }

    function test_setFee_revertsForStaticFeeKey() public {
        PoolKey memory staticKey = key;
        staticKey.fee = 500;
        vm.expectRevert(DynamicFeeHook.NotDynamicFee.selector);
        hook.setFee(staticKey, HIGH_FEE);
    }

    function test_setFee_revertsForUninitializedPool() public {
        vm.expectRevert(Pool.PoolNotInitialized.selector);
        hook.setFee(key, HIGH_FEE);
    }

    function testFuzz_setFee_anyValidFee(uint24 newFee) public {
        newFee = uint24(bound(newFee, 0, LPFeeLibrary.MAX_LP_FEE));
        vm.assume(newFee != INITIAL_FEE);
        manager.initialize(key, SQRT_PRICE_1_1);

        vm.expectEmit(true, false, false, true, address(hook));
        emit DynamicFeeHook.FeeUpdated(poolId, INITIAL_FEE, newFee);
        hook.setFee(key, newFee);
        assertEq(_lpFee(), newFee);
    }

    // --- the Base Sepolia pool settings, on a local PoolManager ---

    /// @dev Same key, start price and ETH-only seed range as script/Launch.s.sol, with a 6-decimal token at
    ///      the USDC address. A 0.1 ETH seed quotes 100 USDC -> about 0.06 ETH, and 10% fee cuts that by ~10%.
    function test_testPool_quotes100UsdcToEthAndFeeChangeMovesIt() public {
        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("USD Coin", "USDC", uint8(6)), BaseSepolia.USDC);
        DynamicFeeHook poolHook = _deployHookAt(address(uint160(0x7777) << 144 | FLAGS), address(this));
        PoolKey memory poolKey = BaseSepolia.poolKey(IHooks(address(poolHook)));
        PoolId id = poolKey.toId();

        uint160 startPrice = TickMath.getSqrtPriceAtTick(BaseSepolia.START_TICK);
        manager.initialize(poolKey, startPrice);
        (int24 tickLower, int24 tickUpper) = BaseSepolia.seedRange(startPrice);
        assertEq(tickLower, BaseSepolia.START_TICK, "seed starts at the start price");

        uint256 seedWei = 0.1 ether;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount0(
            TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), seedWei
        );
        uint256 usdcBefore = MockERC20(BaseSepolia.USDC).balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity{value: seedWei + 1}(
            poolKey, ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(liquidity)), 0), ZERO_BYTES
        );
        assertEq(MockERC20(BaseSepolia.USDC).balanceOf(address(this)), usdcBefore, "seed takes no USDC");

        V4Quoter quoter = new V4Quoter(manager);
        IV4Quoter.QuoteExactSingleParams memory q =
            IV4Quoter.QuoteExactSingleParams({poolKey: poolKey, zeroForOne: false, exactAmount: 100e6, hookData: ""});

        (uint256 outLowFee,) = quoter.quoteExactInputSingle(q);
        // 100 USDC at ~1650.83 USDC/ETH is 0.0606 ETH before fee and price impact.
        assertApproxEqRel(outLowFee, 0.0602 ether, 0.01e18);

        poolHook.setFee(poolKey, HIGH_FEE);
        assertEq(poolHook.feeOf(id), HIGH_FEE);
        (uint256 outHighFee,) = quoter.quoteExactInputSingle(q);
        assertApproxEqRel(outHighFee, outLowFee * 900_000 / 999_500, 0.01e18);
    }

    function test_seedRange_roundsUpToTheNextUsableTick() public pure {
        uint160 between = TickMath.getSqrtPriceAtTick(BaseSepolia.START_TICK) + 1;
        (int24 lower, int24 upper) = BaseSepolia.seedRange(between);
        assertEq(lower, BaseSepolia.START_TICK + BaseSepolia.TICK_SPACING);
        assertEq(upper, lower + BaseSepolia.SEED_RANGE_TICKS);

        (lower,) = BaseSepolia.seedRange(TickMath.getSqrtPriceAtTick(BaseSepolia.START_TICK - 3));
        assertEq(lower, BaseSepolia.START_TICK, "a price between ticks rounds up, never down");
    }
}
