// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {BaseSepolia} from "./BaseSepolia.sol";

/// @notice Shared pieces of the test pool scripts. Every script that sends transactions runs through
///         scripts/with-key.mjs, which puts the deployer key in PRIVATE_KEY.
abstract contract TestPoolScript is Script {
    using StateLibrary for IPoolManager;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(BaseSepolia.POOL_MANAGER);
    IPositionManager internal constant POSITION_MANAGER = IPositionManager(BaseSepolia.POSITION_MANAGER);

    string internal constant DEPLOYMENT_FILE = "deployments/base-sepolia.json";

    function _requireBaseSepolia() internal view {
        require(block.chainid == BaseSepolia.CHAIN_ID, "not Base Sepolia");
    }

    function _deployerKey() internal view returns (uint256) {
        return vm.envUint("PRIVATE_KEY");
    }

    /// @dev The hook from HOOK, or else from the deployment record.
    function _hook() internal view returns (IHooks) {
        address fromEnv = vm.envOr("HOOK", address(0));
        if (fromEnv != address(0)) return IHooks(fromEnv);
        return IHooks(vm.parseJsonAddress(vm.readFile(DEPLOYMENT_FILE), ".hook"));
    }

    /// @dev Mints an ETH-only position worth `amountWei` just above the current price. Must run inside a broadcast.
    ///      MINT_POSITION, then SETTLE_PAIR pays the ETH (USDC owed is 0), then SWEEP returns the rounding spare.
    function _seed(PoolKey memory key, uint256 amountWei, address recipient) internal returns (uint256 tokenId) {
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(poolId);
        require(sqrtPriceX96 != 0, "pool not initialized");

        (int24 tickLower, int24 tickUpper) = BaseSepolia.seedRange(sqrtPriceX96, key.tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount0(
            TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amountWei
        );
        require(liquidity > 0, "seed too small");

        uint256 amount0Max = amountWei + 1; // the PoolManager rounds the owed amount up
        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, tickLower, tickUpper, liquidity, amount0Max, uint128(0), recipient, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, recipient);

        // Read during simulation: if another mint lands first, the real id is higher. The receipt's
        // Transfer event has the real one.
        tokenId = POSITION_MANAGER.nextTokenId();
        POSITION_MANAGER.modifyLiquidities{value: amount0Max}(abi.encode(actions, params), block.timestamp + 600);

        console.log("seed position id (expected):", tokenId);
        console.log("seed ETH (wei):", amountWei);
        console.log("seed liquidity:", liquidity);
        console.log("seed ticks lower/upper:");
        console.logInt(tickLower);
        console.logInt(tickUpper);
    }
}
