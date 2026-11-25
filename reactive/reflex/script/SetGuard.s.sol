// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Script.sol";

import {PoolReflex} from "../src/PoolReflex.sol";
import {ReflexConfig} from "./ReflexConfig.sol";

/// @notice Points PoolReflex at PoolGuard, once (1 transaction on Lasna). After this the loop is live.
/// @dev REFLEX=<on Lasna> GUARD=<on Base Sepolia> forge script script/SetGuard.s.sol --rpc-url lasna --broadcast
contract SetGuard is ReflexConfig {
    function run() external {
        _requireChain(LASNA);
        PoolReflex reflex = PoolReflex(payable(vm.envAddress("REFLEX")));
        address guard = vm.envAddress("GUARD");
        vm.startBroadcast(_key());
        reflex.setGuard(guard);
        vm.stopBroadcast();
        console.log("PoolReflex.guard:", reflex.guard());
    }
}
