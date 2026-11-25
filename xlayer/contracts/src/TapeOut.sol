// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The TapeOut contracts on X Layer mainnet (chain 196), as far as the tape-out uses them. Read from the deployed
/// bytecode and checked on a fork on 2026-11-26; the TapeOut factory is upgradeable, so fees and shapes can change.

/// The factory that makes processors. Since its last upgrade it takes its deploy fee in BEM (transferFrom).
interface ITapeOutFactory {
    function createCPU(
        string calldata name,
        string calldata symbol,
        string calldata story,
        uint256 transistorSupply,
        uint256 mintPrice
    ) external returns (address transistors, address circuits);
    function deployFee() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function cpuCount() external view returns (uint256);
    /// The i-th processor (circuits contract) the factory made.
    function cpus(uint256 i) external view returns (address);
}

/// A processor: stores netlists and evaluates them.
interface ITapeOutProcessor {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function transistors() external view returns (address);
    /// The last circuit id given out (ids start at 1).
    function nextId() external view returns (uint256);
    function name() external view returns (string memory);
}

/// A processor's NAND transistors (ERC-1155, id 0). A tape-out needs one per gate in the netlist.
interface ITapeOutTransistors {
    /// Takes price × amount plus the protocol fee in BEM (transferFrom) on processors the upgraded factory makes.
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    /// Who made this processor with the factory.
    function creator() external view returns (address);
    /// The processor this transistor contract belongs to.
    function circuits() external view returns (address);
}

library TapeOutAddresses {
    uint256 internal constant CHAIN_ID = 196;
    /// TapeOut CPU factory.
    address internal constant FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    /// BEM, the token the factory charges in (8 decimals).
    address internal constant BEM = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    /// LI.FI Diamond, the only contract the swap quote may call.
    address internal constant LIFI_DIAMOND = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
}

/// `eval` input packing: pin i is bit i % 8 of byte i / 8.
library TapeOutPins {
    function pack(uint256 vector, uint256 pins) internal pure returns (bytes memory packed) {
        packed = new bytes((pins + 7) / 8);
        for (uint256 pin = 0; pin < pins; pin++) {
            if ((vector >> pin) & 1 == 1) packed[pin / 8] = bytes1(uint8(packed[pin / 8]) | uint8(1 << (pin % 8)));
        }
    }
}
