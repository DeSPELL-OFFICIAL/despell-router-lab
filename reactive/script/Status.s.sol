// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {BaseSepolia} from "./BaseSepolia.sol";

/// @notice Read-only: prints the deployer's ETH balance on the chain of --rpc-url (and USDC on Base Sepolia).
/// @dev forge script script/Status.s.sol --rpc-url base_sepolia   (run through scripts/with-key.mjs)
contract Status is Script {
    function run() external view {
        address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));
        console.log("chain id:", block.chainid);
        console.log("deployer (short):", _short(deployer));
        console.log("ETH  (wei):", deployer.balance);
        if (block.chainid == BaseSepolia.CHAIN_ID) {
            console.log("USDC (6 decimals):", IERC20(BaseSepolia.USDC).balanceOf(deployer));
        }
    }

    /// @notice The full public address of the deployer (for faucets). `--sig "fullAddress()"`
    function fullAddress() external view {
        console.log("deployer:", vm.addr(vm.envUint("PRIVATE_KEY")));
    }

    function _short(address a) private pure returns (string memory) {
        string memory s = vm.toString(a);
        bytes memory b = bytes(s);
        bytes memory head = new bytes(6);
        bytes memory tail = new bytes(6);
        for (uint256 i; i < 6; i++) {
            head[i] = b[i];
            tail[i] = b[36 + i];
        }
        return string.concat(string(head), "...", string(tail));
    }
}
