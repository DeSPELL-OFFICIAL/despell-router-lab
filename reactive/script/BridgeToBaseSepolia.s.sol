// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

interface IL1StandardBridge {
    function depositETH(uint32 minGasLimit, bytes calldata extraData) external payable;
}

/// @notice Moves test ETH from Ethereum Sepolia to the same address on Base Sepolia through Base's
///         official L1StandardBridge. Testnet only.
/// @dev Bridge address: https://docs.base.org/base-chain/network-information/base-contracts
///      ("Ethereum Testnet (Sepolia)" table).
///      BRIDGE_WEI=<amount> forge script script/BridgeToBaseSepolia.s.sol --rpc-url sepolia --broadcast
///      (run through scripts/with-key.mjs)
contract BridgeToBaseSepolia is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    IL1StandardBridge internal constant BRIDGE = IL1StandardBridge(0xfd0Bf71F60660E2f608ed56e1659C450eB113120);
    uint32 internal constant MIN_GAS_LIMIT = 200_000;

    function run() external {
        require(block.chainid == SEPOLIA_CHAIN_ID, "not Ethereum Sepolia");
        uint256 amount = vm.envUint("BRIDGE_WEI");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(amount > 0 && amount <= vm.addr(pk).balance, "bad amount");

        vm.startBroadcast(pk);
        BRIDGE.depositETH{value: amount}(MIN_GAS_LIMIT, "");
        vm.stopBroadcast();
        console.log("deposited (wei):", amount);
    }
}
