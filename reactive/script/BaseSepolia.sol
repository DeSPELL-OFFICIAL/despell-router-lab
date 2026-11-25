// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @notice Base Sepolia (84532) addresses and the test pool settings shared by every script.
/// @dev Uniswap v4 addresses: https://docs.uniswap.org/contracts/v4/deployments (Base Sepolia).
///      USDC: Circle's test USDC, https://developers.circle.com/stablecoins/usdc-contract-addresses.
library BaseSepolia {
    uint256 internal constant CHAIN_ID = 84532;

    address internal constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address internal constant POSITION_MANAGER = 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80;
    address internal constant STATE_VIEW = 0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4;
    address internal constant QUOTER = 0x5e6B8B8AFA7e5CEF6C09dd2A67aBA9FB12C75623;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// @notice LP fee the pool starts with: 500 = 0.05%.
    uint24 internal constant INITIAL_FEE = 500;
    /// @notice Tick spacing of the v3 0.05% tier.
    int24 internal constant TICK_SPACING = 10;

    /// @notice Tick spacing of the second test pool on the same hook (the v3 0.3% tier). Same hook, so
    ///         PoolReflex watches it too; the app's quote takes whichever unmarked pool pays more.
    int24 internal constant SECOND_TICK_SPACING = 60;
    /// @notice Starting tick: 1.0001^-202230 * 1e12 = about 1650.83 USDC per ETH.
    int24 internal constant START_TICK = -202230;
    /// @notice Width of a seed position: 200 ticks, about 2% above the price at seeding time.
    int24 internal constant SEED_RANGE_TICKS = 200;

    /// @notice The ETH/USDC test pool on a given hook. Native ETH (address 0) sorts first.
    function poolKey(IHooks hook) internal pure returns (PoolKey memory) {
        return poolKey(hook, TICK_SPACING);
    }

    /// @notice An ETH/USDC dynamic-fee pool on a given hook with a given tick spacing.
    function poolKey(IHooks hook, int24 tickSpacing) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(USDC),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: tickSpacing,
            hooks: hook
        });
    }

    /// @notice The pool key for a tick spacing the scripts know: TICK_SPACING or SECOND_TICK_SPACING.
    function knownPoolKey(IHooks hook, int256 tickSpacing) internal pure returns (PoolKey memory) {
        require(
            tickSpacing == TICK_SPACING || tickSpacing == SECOND_TICK_SPACING,
            "TICK_SPACING must be 10 (first pool) or 60 (second pool)"
        );
        return poolKey(hook, int24(tickSpacing));
    }

    /// @notice Range for an ETH-only seed position: it starts at the first usable tick at or above the
    ///         current price, so the position needs ETH and no USDC. It serves USDC -> ETH swaps.
    function seedRange(uint160 sqrtPriceX96) internal pure returns (int24 tickLower, int24 tickUpper) {
        return seedRange(sqrtPriceX96, TICK_SPACING);
    }

    /// @notice The same range for a pool with another tick spacing: at least SEED_RANGE_TICKS wide, in whole spacings.
    function seedRange(uint160 sqrtPriceX96, int24 tickSpacing)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        tickLower = tick / tickSpacing * tickSpacing;
        if (tickLower > tick) tickLower -= tickSpacing; // round toward negative infinity
        if (TickMath.getSqrtPriceAtTick(tickLower) < sqrtPriceX96) tickLower += tickSpacing;
        tickUpper = tickLower + (SEED_RANGE_TICKS + tickSpacing - 1) / tickSpacing * tickSpacing;
    }
}
