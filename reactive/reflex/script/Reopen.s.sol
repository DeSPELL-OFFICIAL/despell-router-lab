// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Script.sol";

import {PoolGuard} from "../src/PoolGuard.sol";
import {ReflexConfig} from "./ReflexConfig.sol";

/// @notice The operator reopens the test pool on PoolGuard (1 transaction). In the router this happens only after
///         the pool's test trades pass again; the latency runs reopen between measurements.
/// @dev GUARD=<on Base Sepolia> forge script script/Reopen.s.sol --rpc-url base_sepolia --broadcast
///      POOL_ID=<bytes32> reopens another pool; the default is the first test pool.
contract Reopen is ReflexConfig {
    function run() external {
        _requireChain(BASE_SEPOLIA);
        PoolGuard guard = PoolGuard(payable(vm.envAddress("GUARD")));
        bytes32 poolId = vm.envOr("POOL_ID", POOL_ID);
        console.log("pool:");
        console.logBytes32(poolId);
        console.log("status before:", guard.statusOf(poolId));
        vm.startBroadcast(_key());
        guard.reopen(poolId);
        vm.stopBroadcast();
        console.log("status after:", guard.statusOf(poolId));
    }
}
