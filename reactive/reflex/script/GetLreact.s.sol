// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Script.sol";

import {ReflexConfig} from "./ReflexConfig.sol";

interface ILreactFaucet {
    function request(address receiver) external payable;
}

/// @notice Buys testnet lREACT on Lasna with Base Sepolia ETH through Reactive's faucet (1 transaction).
/// @dev FAUCET_WEI=<wei> forge script script/GetLreact.s.sol --rpc-url base_sepolia --broadcast
///      (run through ../scripts/with-key.mjs). The faucet takes at most 5 ETH per transaction.
contract GetLreact is ReflexConfig {
    function run() external {
        _requireChain(BASE_SEPOLIA);
        uint256 amount = vm.envUint("FAUCET_WEI");
        require(amount > 0 && amount <= 0.05 ether, "FAUCET_WEI out of range for this lab");
        uint256 pk = _key();
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        ILreactFaucet(LREACT_FAUCET).request{value: amount}(me);
        vm.stopBroadcast();
        console.log("faucet ETH (wei):", amount);
        console.log("expected lREACT (wei):", amount * 100);
    }
}
