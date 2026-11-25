// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {TapeOutScript} from "../script/TapeOut.s.sol";
import {ITapeOutFactory, ITapeOutProcessor, TapeOutAddresses} from "../src/TapeOut.sol";

/// The tape-out script on a fork of X Layer mainnet, from a test wallet. Nothing is sent to the chain.
/// Run: FOUNDRY_PROFILE=fork forge test -vv
///
/// One test runs the whole thing in order. The script reads environment variables (BEM_QUOTE, DESPELL_PROCESSOR),
/// which the whole test process shares, so the cases that set them must not run side by side.
contract TapeOutForkTest is Test {
    /// A throwaway test key; its address only ever holds funds on the fork.
    uint256 internal constant KEY = 0xA11CE;
    IERC20 internal constant BEM = IERC20(TapeOutAddresses.BEM);
    ITapeOutFactory internal constant FACTORY = ITapeOutFactory(TapeOutAddresses.FACTORY);
    address internal constant ORDER_GUARD = 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355;
    string internal constant QUOTE = "quote/bem-swap.json";

    address internal wallet;
    TapeOutScript internal script;

    function setUp() public {
        vm.createSelectFork("xlayer");
        wallet = vm.addr(KEY);
        vm.setEnv("PRIVATE_KEY", vm.toString(KEY));
        vm.setEnv("BEM_QUOTE", QUOTE);
        vm.setEnv("DESPELL_PROCESSOR", vm.toString(address(0)));
        script = new TapeOutScript();
    }

    /// From OKB only when quote/bem-swap.json was fetched for this test wallet
    /// (node ../scripts/quote-bem.ts --wallet <address of KEY>); otherwise BEM is dealt on the fork.
    function test_wholeRun() public {
        vm.deal(wallet, 0.03 ether);
        if (vm.exists(QUOTE)) {
            swapChecks();
        } else {
            console.log("no quote/bem-swap.json for", wallet, "- dealing BEM instead of swapping");
            deal(address(BEM), wallet, 0.12e8);
        }

        uint256 processors = FACTORY.cpuCount();
        script.createProcessor();
        script.createProcessor();
        assertEq(FACTORY.cpuCount(), processors + 1, "one processor only");
        address processor = FACTORY.cpus(processors);
        assertEq(BEM.allowance(wallet, address(FACTORY)), 0, "factory approval used up");

        // Later runs name the recorded processor instead of searching for it.
        vm.setEnv("DESPELL_PROCESSOR", vm.toString(processor));
        script.tapeOutCircuit();
        uint256 okb = wallet.balance;
        uint256 bem = BEM.balanceOf(wallet);
        script.tapeOutCircuit();
        assertEq(wallet.balance, okb, "second tape-out run spends no OKB");
        assertEq(BEM.balanceOf(wallet), bem, "second tape-out run spends no BEM");
        assertEq(BEM.allowance(wallet, ITapeOutProcessor(processor).transistors()), 0, "transistor approval used up");
        script.status();

        // A recorded address that is not this wallet's DeSpell processor stops the run.
        vm.setEnv("DESPELL_PROCESSOR", vm.toString(ORDER_GUARD));
        vm.expectRevert(bytes("DESPELL_PROCESSOR is not a DeSpell processor made by this wallet"));
        script.tapeOutCircuit();

        console.log("processor", processor);
        console.log("BEM left / OKB spent (wei, fees and swap; no gas on a fork):", bem, 0.03 ether - okb);
    }

    /// The swap: two tampered quotes are refused, the real one runs once and then not again.
    function swapChecks() internal {
        string memory json = vm.readFile(QUOTE);
        bytes memory data = vm.parseJsonBytes(json, ".data");

        // Same quote file fields, but the calldata pays someone else: refused from the calldata itself.
        writeQuote(json, withWord(data, 3, uint256(uint160(address(0xBEEF)))), "quote/tampered-receiver.json");
        vm.setEnv("BEM_QUOTE", "quote/tampered-receiver.json");
        vm.expectRevert(bytes("swap calldata pays another address"));
        script.swapForBem();

        // Same fields, but the calldata's own minimum is 1.
        writeQuote(json, withWord(data, 4, 1), "quote/tampered-minimum.json");
        vm.setEnv("BEM_QUOTE", "quote/tampered-minimum.json");
        vm.expectRevert(bytes("swap calldata's minimum received is too small"));
        script.swapForBem();

        vm.setEnv("BEM_QUOTE", QUOTE);
        script.swapForBem();
        uint256 afterSwap = BEM.balanceOf(wallet);
        script.swapForBem();
        assertEq(BEM.balanceOf(wallet), afterSwap, "second swap run does nothing");
        console.log("BEM from the swap (1e-8):", afterSwap);
    }

    function writeQuote(string memory json, bytes memory data, string memory path) internal {
        string memory key = path;
        vm.serializeUint(key, "chainId", vm.parseJsonUint(json, ".chainId"));
        vm.serializeAddress(key, "to", vm.parseJsonAddress(json, ".to"));
        vm.serializeUint(key, "value", vm.parseJsonUint(json, ".value"));
        vm.serializeAddress(key, "fromAddress", vm.parseJsonAddress(json, ".fromAddress"));
        vm.serializeAddress(key, "toAddress", vm.parseJsonAddress(json, ".toAddress"));
        vm.serializeAddress(key, "toToken", vm.parseJsonAddress(json, ".toToken"));
        vm.serializeUint(key, "toAmountMin", vm.parseJsonUint(json, ".toAmountMin"));
        vm.serializeUint(key, "fetchedAt", vm.parseJsonUint(json, ".fetchedAt"));
        vm.writeJson(vm.serializeBytes(key, "data", data), path);
    }

    /// A copy of ABI calldata with argument word `index` replaced.
    function withWord(bytes memory data, uint256 index, uint256 value) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        assembly ("memory-safe") {
            mstore(add(add(out, 0x24), mul(index, 0x20)), value)
        }
    }
}
