// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Script.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

import {DynamicFeeHook} from "../src/DynamicFeeHook.sol";
import {BaseSepolia} from "./BaseSepolia.sol";
import {TestPoolScript} from "./TestPoolScript.sol";

/// @notice Adds the second test pool on the same hook, as two transactions: 1. initialize the ETH/USDC
///         dynamic-fee pool with tick spacing 60 at the first pool's current price (the hook sets 0.05% and emits
///         FeeUpdated, so PoolReflex marks the new pool narrowed, as it does every new pool), 2. seed an ETH-only
///         position of SEED_WEI. The app's quote then has two pools to choose from.
/// @dev SEED_WEI=<wei> forge script script/LaunchSecondPool.s.sol --rpc-url base_sepolia --broadcast --slow
///      (run through scripts/with-key.mjs; the hook comes from HOOK or deployments/base-sepolia.json)
contract LaunchSecondPool is TestPoolScript {
    using StateLibrary for IPoolManager;

    function run() external returns (PoolId poolId) {
        return launchSecond(_hook(), vm.envUint("SEED_WEI"));
    }

    function launchSecond(IHooks hook, uint256 seedWei) public returns (PoolId poolId) {
        _requireBaseSepolia();
        (uint160 firstPrice,,,) = POOL_MANAGER.getSlot0(BaseSepolia.poolKey(hook).toId());
        require(firstPrice != 0, "first pool not initialized");
        PoolKey memory key = BaseSepolia.poolKey(hook, BaseSepolia.SECOND_TICK_SPACING);
        poolId = key.toId();
        (uint160 existing,,,) = POOL_MANAGER.getSlot0(poolId);
        require(existing == 0, "second pool already initialized");

        uint256 pk = _deployerKey();
        vm.startBroadcast(pk);
        POOL_MANAGER.initialize(key, firstPrice);
        _seed(key, seedWei, vm.addr(pk));
        vm.stopBroadcast();

        require(DynamicFeeHook(address(hook)).feeOf(poolId) == BaseSepolia.INITIAL_FEE, "initial fee not set");
        console.log("second pool id:");
        console.logBytes32(PoolId.unwrap(poolId));
        console.log("start sqrtPriceX96 (the first pool's):", firstPrice);
    }
}
