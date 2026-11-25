// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Script.sol";

import {PoolGuard} from "../src/PoolGuard.sol";
import {ReflexConfig} from "./ReflexConfig.sol";

/// @notice The operator reopens the test pool on PoolGuard (1 transaction). In the router this happens only after
///         the pool's test trades pass again; the latency runs reopen between measurements.
/// @dev GUARD=<on Base Sepolia> forge script script/Reopen.s.sol --rpc-url base_sepolia --broadcast
contract Reopen is ReflexConfig {
    function run() external {
        _requireChain(BASE_SEPOLIA);
        PoolGuard guard = PoolGuard(payable(vm.envAddress("GUARD")));
        console.log("status before:", guard.statusOf(POOL_ID));
        vm.startBroadcast(_key());
        guard.reopen(POOL_ID);
        vm.stopBroadcast();
        console.log("status after:", guard.statusOf(POOL_ID));
    }
}
