// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Script.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {DynamicFeeHook} from "../src/DynamicFeeHook.sol";
import {BaseSepolia} from "./BaseSepolia.sol";
import {TestPoolScript} from "./TestPoolScript.sol";

/// @notice One-time launch of the test pool on Base Sepolia, as three transactions:
///         1. deploy DynamicFeeHook through the CREATE2 deployer at an address that carries only the
///            afterInitialize flag, 2. initialize the ETH/USDC dynamic-fee pool (the hook sets 0.05%),
///         3. seed an ETH-only position of SEED_WEI.
/// @dev SEED_WEI=<wei> forge script script/Launch.s.sol --rpc-url base_sepolia --broadcast --slow
///      (run through scripts/with-key.mjs)
contract Launch is TestPoolScript {
    function run() external returns (DynamicFeeHook hook, PoolId poolId) {
        return launch(vm.envUint("SEED_WEI"));
    }

    function launch(uint256 seedWei) public returns (DynamicFeeHook hook, PoolId poolId) {
        _requireBaseSepolia();
        uint256 pk = _deployerKey();
        address owner = vm.addr(pk);

        bytes memory args = abi.encode(POOL_MANAGER, owner, BaseSepolia.INITIAL_FEE);
        (address mined, bytes32 salt) = HookMiner.find(
            CREATE2_FACTORY, uint160(Hooks.AFTER_INITIALIZE_FLAG), type(DynamicFeeHook).creationCode, args
        );

        PoolKey memory key = BaseSepolia.poolKey(IHooks(mined));
        uint160 startPrice = TickMath.getSqrtPriceAtTick(BaseSepolia.START_TICK);

        vm.startBroadcast(pk);
        hook = new DynamicFeeHook{salt: salt}(POOL_MANAGER, owner, BaseSepolia.INITIAL_FEE);
        require(address(hook) == mined, "hook address mismatch");
        POOL_MANAGER.initialize(key, startPrice);
        _seed(key, seedWei, owner);
        vm.stopBroadcast();

        poolId = key.toId();
        require(hook.feeOf(poolId) == BaseSepolia.INITIAL_FEE, "initial fee not set");
        console.log("hook:", address(hook));
        console.log("hook salt:");
        console.logBytes32(salt);
        console.log("pool id:");
        console.logBytes32(PoolId.unwrap(poolId));
        console.log("lp fee:", hook.feeOf(poolId));
    }
}
