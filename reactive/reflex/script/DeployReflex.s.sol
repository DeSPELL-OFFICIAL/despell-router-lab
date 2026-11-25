// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Script.sol";

import {PoolReflex} from "../src/PoolReflex.sol";
import {ReflexConfig} from "./ReflexConfig.sol";

/// @notice Deploys PoolReflex on Reactive Lasna and funds it for reactive transactions (1 transaction). The
///         constructor subscribes to the hook's FeeUpdated on Base Sepolia.
/// @dev REFLEX_FUND_WEI=<wei> forge script script/DeployReflex.s.sol --rpc-url lasna --broadcast
contract DeployReflex is ReflexConfig {
    function run() external returns (PoolReflex reflex) {
        _requireChain(LASNA);
        uint256 fund = vm.envUint("REFLEX_FUND_WEI");
        uint256 pk = _key();
        vm.startBroadcast(pk);
        reflex = new PoolReflex{value: fund}(BASE_SEPOLIA, HOOK, BASE_SEPOLIA, vm.addr(pk));
        vm.stopBroadcast();
        console.log("PoolReflex:", address(reflex));
        console.log("funded (lREACT wei):", fund);
    }
}
