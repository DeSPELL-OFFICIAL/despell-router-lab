// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {
    ITapeOutFactory,
    ITapeOutProcessor,
    ITapeOutTransistors,
    TapeOutAddresses,
    TapeOutPins
} from "../src/TapeOut.sol";

/// Tapes the pool judgment circuit out on X Layer mainnet on a DeSpell processor, from one wallet, in steps that can
/// each be run again safely:
///
///   --sig "status()"          read only: balances, what each step still needs, the processor and circuit if made
///   --sig "swapForBem()"      OKB -> BEM through a LI.FI quote (quote/bem-swap.json, made by scripts/quote-bem.ts),
///                             checked here: caller, token, OKB spent, age, and the receiver and minimum received
///                             read from the swap calldata itself. Skipped when the wallet already holds the BEM the
///                             next steps need.
///   --sig "createProcessor()" BEM approve(factory, deployFee) -> factory.createCPU. Skipped if this wallet already
///                             made a DeSpell processor.
///   --sig "tapeOutCircuit()"  finds the processor this wallet made (on chain, after it was made, so no transaction
///                             goes to an address that only existed in a simulation; DESPELL_PROCESSOR names it once it
///                             is recorded), then BEM approve(transistors,
///                             mint cost) -> mint(0, nand) -> tapeout{TAPEOUT_FEE}, and checks eval on the sample
///                             vectors against the rule function. NAND already held are not bought again; a netlist
///                             already on the processor is only checked.
///
/// Every approval is for the exact amount. Key: PRIVATE_KEY in the environment, or --sender for a dry run.
/// Limits: the key reaches forge through the environment of one local process (with-key.mjs); the TapeOut factory is
/// upgradeable, so its fees and shapes are read again on every run.
contract TapeOutScript is Script {
    ITapeOutFactory internal constant FACTORY = ITapeOutFactory(TapeOutAddresses.FACTORY);
    IERC20 internal constant BEM = IERC20(TapeOutAddresses.BEM);

    string internal constant NAME = "DeSpell Pool Judgment";
    string internal constant SYMBOL = "DSPJ";
    string internal constant STORY =
        "The DeSpell AI router's pool judgment rules as one NAND circuit: anyone can feed the same facts and get the same judgment.";
    uint256 internal constant SUPPLY = 10_000;
    /// Smallest NAND price (1e-8 BEM). The protocol fee per mint call is the factory's.
    uint256 internal constant NAND_PRICE = 1;
    /// How far back the factory's list is searched for this wallet's processor when DESPELL_PROCESSOR is not set.
    uint256 internal constant SEARCH = 50;

    /// The swap may spend at most this much OKB (about 2 USD at 79 USD per OKB).
    uint256 internal constant MAX_SWAP_OKB = 0.025 ether;
    /// A quote older than this is not used.
    uint256 internal constant QUOTE_TTL = 5 minutes;

    string internal constant NETLIST = "../circuit/pool-judgment.json";
    string internal constant SAMPLES = "../circuit/pool-judgment-samples.json";
    string internal constant QUOTE = "quote/bem-swap.json";

    /// LI.FI swap functions that take native OKB. All share the head (bytes32 transactionId, string integrator,
    /// string referrer, address receiver, uint256 minAmountOut, ...): word 3 is who receives, word 4 the minimum.
    bytes4 internal constant SWAP_GENERIC = 0x4630a0d8; // swapTokensGeneric(...,(address,address,address,address,uint256,bytes,bool)[])
    bytes4 internal constant SWAP_SINGLE_NATIVE = 0xaf7060fd; // swapTokensSingleV3NativeToERC20(...)
    bytes4 internal constant SWAP_MULTIPLE_NATIVE = 0x736eac0b; // swapTokensMultipleV3NativeToERC20(...)

    struct Circuit {
        bytes netlist;
        uint32 nIn;
        uint32 nOut;
        uint256 nand;
    }

    // ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────

    function status() external view {
        onXLayer();
        (, address sender) = signer();
        Circuit memory circuit = readCircuit();
        console.log("wallet", sender);
        console.log("OKB held (wei):", sender.balance);
        console.log("BEM held / needed for the steps left (1e-8):", BEM.balanceOf(sender), bemNeeded(sender, circuit));
        console.log("BEM allowance to the factory (1e-8):", BEM.allowance(sender, address(FACTORY)));
        (ITapeOutProcessor processor, ITapeOutTransistors transistors) = findProcessor(sender);
        if (address(processor) == address(0)) {
            console.log("no DeSpell processor made by this wallet yet");
            return;
        }
        console.log("processor", address(processor));
        console.log("transistors", address(transistors));
        console.log("BEM allowance to the transistors (1e-8):", BEM.allowance(sender, address(transistors)));
        console.log("NAND held:", transistors.balanceOf(sender, 0));
        uint256 id = existingCircuit(processor, circuit.netlist);
        if (id == 0) console.log("circuit not taped out yet");
        else console.log("circuit id", id);
    }

    function swapForBem() external {
        onXLayer();
        (uint256 key, address sender) = signer();
        Circuit memory circuit = readCircuit();
        uint256 needed = bemNeeded(sender, circuit);
        uint256 held = BEM.balanceOf(sender);
        console.log("BEM held / needed (1e-8):", held, needed);
        if (held >= needed) {
            console.log("enough BEM already, no swap");
            return;
        }

        string memory json = vm.readFile(vm.envOr("BEM_QUOTE", QUOTE));
        address to = vm.parseJsonAddress(json, ".to");
        bytes memory data = vm.parseJsonBytes(json, ".data");
        uint256 value = vm.parseJsonUint(json, ".value");
        uint256 minOut = vm.parseJsonUint(json, ".toAmountMin");
        uint256 fetchedAt = vm.parseJsonUint(json, ".fetchedAt");
        require(vm.parseJsonUint(json, ".chainId") == TapeOutAddresses.CHAIN_ID, "quote is for another chain");
        require(to == TapeOutAddresses.LIFI_DIAMOND, "quote calls a contract other than the LI.FI Diamond");
        require(vm.parseJsonAddress(json, ".fromAddress") == sender, "quote is for another wallet");
        require(vm.parseJsonAddress(json, ".toAddress") == sender, "quote pays another address");
        require(vm.parseJsonAddress(json, ".toToken") == address(BEM), "quote buys another token");
        require(minOut >= needed - held, "quote's minimum received is too small");
        require(value <= MAX_SWAP_OKB, "quote spends too much OKB");
        require(block.timestamp <= fetchedAt + QUOTE_TTL, "quote is too old: fetch it again");
        requireSwapCall(data, sender, needed - held);
        console.log("swap: OKB in (wei), BEM minimum out (1e-8):", value, minOut);

        start(key);
        (bool ok,) = to.call{value: value}(data);
        vm.stopBroadcast();
        require(ok, "swap reverted");
        require(BEM.balanceOf(sender) >= held + minOut, "swap paid less than its minimum");
        console.log("BEM held after the swap (1e-8):", BEM.balanceOf(sender));
    }

    function createProcessor() external {
        onXLayer();
        (uint256 key, address sender) = signer();
        (ITapeOutProcessor existing,) = findProcessor(sender);
        if (address(existing) != address(0)) {
            console.log("this wallet already has a DeSpell processor:", address(existing));
            return;
        }
        uint256 deployFee = FACTORY.deployFee();
        console.log("BEM deploy fee / held (1e-8):", deployFee, BEM.balanceOf(sender));
        require(BEM.balanceOf(sender) >= deployFee, "not enough BEM for the deploy fee");
        start(key);
        BEM.approve(address(FACTORY), deployFee);
        FACTORY.createCPU(NAME, SYMBOL, STORY, SUPPLY, NAND_PRICE);
        vm.stopBroadcast();
    }

    function tapeOutCircuit() external {
        onXLayer();
        (uint256 key, address sender) = signer();
        Circuit memory circuit = readCircuit();
        (ITapeOutProcessor processor, ITapeOutTransistors transistors) = findProcessor(sender);
        require(address(processor) != address(0), "no DeSpell processor made by this wallet: run createProcessor first");
        console.log("processor", address(processor));
        console.log("transistors", address(transistors));

        uint256 id = existingCircuit(processor, circuit.netlist);
        if (id == 0) {
            start(key);
            uint256 held = transistors.balanceOf(sender, 0);
            if (held < circuit.nand) {
                uint256 count = circuit.nand - held;
                uint256 mintCost = transistors.mintPrice() * count + transistors.protocolFee();
                console.log("BEM mint cost / held (1e-8):", mintCost, BEM.balanceOf(sender));
                require(BEM.balanceOf(sender) >= mintCost, "not enough BEM for the NAND transistors");
                BEM.approve(address(transistors), mintCost);
                transistors.mint(0, count);
            }
            id = processor.tapeout{value: processor.TAPEOUT_FEE()}(circuit.netlist, circuit.nIn, circuit.nOut);
            vm.stopBroadcast();
        } else {
            console.log("netlist already taped out on this processor, checking only");
        }
        console.log("circuit id", id);
        verify(processor, id, circuit);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────

    /// The receiver and the minimum are read from the calldata LI.FI will run, not only from the quote file's fields.
    function requireSwapCall(bytes memory data, address receiver, uint256 minimum) internal pure {
        require(data.length >= 4 + 5 * 32, "swap calldata is too short");
        bytes4 selector = bytes4(data);
        require(
            selector == SWAP_GENERIC || selector == SWAP_SINGLE_NATIVE || selector == SWAP_MULTIPLE_NATIVE,
            "swap calldata calls an unexpected LI.FI function"
        );
        require(calldataWord(data, 3) == uint256(uint160(receiver)), "swap calldata pays another address");
        require(calldataWord(data, 4) >= minimum, "swap calldata's minimum received is too small");
    }

    /// Argument word `index` of ABI calldata (after the 4-byte selector).
    function calldataWord(bytes memory data, uint256 index) internal pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := mload(add(add(data, 0x24), mul(index, 0x20)))
        }
    }

    function onXLayer() internal view {
        require(block.chainid == TapeOutAddresses.CHAIN_ID, "not X Layer mainnet");
    }

    function signer() internal view returns (uint256 key, address sender) {
        key = vm.envOr("PRIVATE_KEY", uint256(0));
        sender = key == 0 ? msg.sender : vm.addr(key);
    }

    function start(uint256 key) internal {
        if (key == 0) vm.startBroadcast();
        else vm.startBroadcast(key);
    }

    function readCircuit() internal view returns (Circuit memory) {
        string memory json = vm.readFile(NETLIST);
        return Circuit({
            netlist: vm.parseJsonBytes(json, ".netlist"),
            nIn: uint32(vm.parseJsonUint(json, ".nIn")),
            nOut: uint32(vm.parseJsonUint(json, ".nOut")),
            nand: vm.parseJsonUint(json, ".nand")
        });
    }

    /// BEM the steps not yet done still need: the deploy fee if there is no processor, the NAND not yet held.
    function bemNeeded(address sender, Circuit memory circuit) internal view returns (uint256 needed) {
        (ITapeOutProcessor processor, ITapeOutTransistors transistors) = findProcessor(sender);
        if (address(processor) == address(0)) {
            return FACTORY.deployFee() + NAND_PRICE * circuit.nand + FACTORY.protocolFee();
        }
        if (existingCircuit(processor, circuit.netlist) != 0) return 0;
        uint256 held = transistors.balanceOf(sender, 0);
        if (held >= circuit.nand) return 0;
        return transistors.mintPrice() * (circuit.nand - held) + transistors.protocolFee();
    }

    /// This wallet's DeSpell processor: the one DESPELL_PROCESSOR names (checked to be ours), or else the newest in the
    /// factory's last SEARCH entries that this wallet made under our name.
    function findProcessor(address sender) internal view returns (ITapeOutProcessor, ITapeOutTransistors) {
        address recorded = vm.envOr("DESPELL_PROCESSOR", address(0));
        if (recorded != address(0)) {
            ITapeOutProcessor named = ITapeOutProcessor(recorded);
            ITapeOutTransistors namedTransistors = ITapeOutTransistors(named.transistors());
            require(
                isOurs(named, namedTransistors, sender),
                "DESPELL_PROCESSOR is not a DeSpell processor made by this wallet"
            );
            return (named, namedTransistors);
        }
        uint256 count = FACTORY.cpuCount();
        uint256 stop = count > SEARCH ? count - SEARCH : 0;
        for (uint256 i = count; i > stop; i--) {
            ITapeOutProcessor processor = ITapeOutProcessor(FACTORY.cpus(i - 1));
            ITapeOutTransistors transistors = ITapeOutTransistors(processor.transistors());
            if (isOurs(processor, transistors, sender)) return (processor, transistors);
        }
        return (ITapeOutProcessor(address(0)), ITapeOutTransistors(address(0)));
    }

    function isOurs(ITapeOutProcessor processor, ITapeOutTransistors transistors, address sender)
        internal
        view
        returns (bool)
    {
        return transistors.creator() == sender && transistors.circuits() == address(processor)
            && keccak256(bytes(processor.name())) == keccak256(bytes(NAME));
    }

    /// The id of this netlist on the processor, or 0.
    function existingCircuit(ITapeOutProcessor processor, bytes memory netlist) internal view returns (uint256) {
        uint256 last = processor.nextId();
        for (uint256 id = 1; id <= last; id++) {
            try processor.netlist(id) returns (bytes memory stored) {
                if (keccak256(stored) == keccak256(netlist)) return id;
            } catch {}
        }
        return 0;
    }

    function verify(ITapeOutProcessor processor, uint256 id, Circuit memory circuit) internal view {
        (uint32 gotIn, uint32 gotOut,, uint32 gates) = processor.circuitInfo(id);
        require(gotIn == circuit.nIn && gotOut == circuit.nOut && gates == circuit.nand, "circuit info differs");
        require(keccak256(processor.netlist(id)) == keccak256(circuit.netlist), "netlist differs");
        string memory json = vm.readFile(SAMPLES);
        uint256[] memory vectors = vm.parseJsonUintArray(json, ".vectors");
        uint256[] memory outputs = vm.parseJsonUintArray(json, ".outputs");
        for (uint256 i = 0; i < vectors.length; i++) {
            bytes memory out = processor.eval(id, TapeOutPins.pack(vectors[i], circuit.nIn));
            require(uint8(out[0]) == outputs[i], "eval differs from the rule function");
        }
        console.log("eval = rule function on sample vectors:", vectors.length);
    }
}
