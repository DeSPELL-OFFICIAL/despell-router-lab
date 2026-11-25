// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Script.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";

import {PoolGuard} from "../src/PoolGuard.sol";
import {ReflexConfig} from "./ReflexConfig.sol";

/// @notice Deploys PoolGuard on Base Sepolia, accepting marks from PoolReflex only, and funds it for callback fees
///         (1 transaction).
/// @dev REFLEX=<PoolReflex on Lasna> GUARD_FUND_WEI=<wei> forge script script/DeployGuard.s.sol --rpc-url base_sepolia --broadcast
contract DeployGuard is ReflexConfig {
    function run() external returns (PoolGuard guard) {
        _requireChain(BASE_SEPOLIA);
        address reflex = vm.envAddress("REFLEX");
        uint256 fund = vm.envUint("GUARD_FUND_WEI");
        // An unfunded PoolGuard cannot pay the callback proxy, so no mark would ever land.
        require(fund > 0 && fund <= 0.005 ether, "GUARD_FUND_WEI must be above 0 and at most 0.005 ETH");
        uint256 pk = _key();
        vm.startBroadcast(pk);
        guard = new PoolGuard{value: fund}(IPayable(payable(CALLBACK_PROXY)), reflex, vm.addr(pk));
        vm.stopBroadcast();
        console.log("PoolGuard:", address(guard));
        console.log("callback sender (PoolReflex):", reflex);
    }
}
