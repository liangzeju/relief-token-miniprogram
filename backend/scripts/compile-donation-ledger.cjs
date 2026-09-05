'use strict';

const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { findImports } = require('./compile-contract.cjs');

const sourceName = 'contracts/ReliefDonationLedger.sol';
const harnessSourceName = 'test/DonationLedgerHarness.sol';
const harnessSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ReliefDonationLedger} from "contracts/ReliefDonationLedger.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// This deliberately incomplete fee policy is for local tests only.
contract DonationLedgerHarness is ReliefDonationLedger {
    constructor(address admin) ReliefDonationLedger(admin) {}
    function _validateDonationFees(DonationPermit calldata permit) internal view override {
        require(permit.feePolicyHash == keccak256("LOCAL_TEST_POLICY_ONLY"), "Local test policy only");
        require(permit.gasReservedWei <= permit.amountWei, "Reserve exceeds amount");
    }
}

contract TestContractRegistrar {
    address public immutable signer;
    constructor(address initialSigner) { signer = initialSigner; }
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        return error == ECDSA.RecoverError.NoError && recovered == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract TestRefundRecipient {
    ReliefDonationLedger public immutable ledger;
    uint8 public mode;
    bool public reentrySucceeded;
    bytes4 public reentryError;
    bytes32 private donationId;
    constructor(address target) { ledger = ReliefDonationLedger(payable(target)); }
    function setMode(uint8 nextMode) external { mode = nextMode; }
    function donate(ReliefDonationLedger.DonationPermit calldata permit, address registrar, bytes calldata signature) external payable {
        donationId = permit.donationId;
        ledger.donate{value: msg.value}(permit, registrar, signature);
    }
    function refund(bytes32 refundId, uint256 amountWei) external {
        ledger.refundUnallocated(refundId, donationId, amountWei);
    }
    receive() external payable {
        require(mode != 1, "Recipient rejects transfer");
        if (mode == 2) {
            bytes memory result;
            (reentrySucceeded, result) = address(ledger).call(abi.encodeCall(
                ledger.refundUnallocated, (keccak256("nested-refund"), donationId, 1)
            ));
            if (result.length >= 4) reentryError = bytes4(result);
        }
    }
}
`;

function compileDonationLedger() {
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } },
  };
  const input = {
    language: 'Solidity',
    sources: {
      [sourceName]: { content: fs.readFileSync(path.resolve(__dirname, '../..', sourceName), 'utf8') },
      [harnessSourceName]: { content: harnessSource },
    },
    settings,
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  const artifact = (file, name) => {
    const compiled = output.contracts[file][name];
    for (const code of [compiled.evm.bytecode, compiled.evm.deployedBytecode]) {
      if (Object.keys(code.linkReferences || {}).length) throw new Error(`Unresolved library links: ${name}`);
    }
    return {
      contractName: name,
      sourceName: file,
      abi: compiled.abi,
      bytecode: `0x${compiled.evm.bytecode.object}`,
      deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
      immutableReferences: compiled.evm.deployedBytecode.immutableReferences || {},
      metadata: JSON.parse(compiled.metadata),
    };
  };
  const production = artifact(sourceName, 'ReliefDonationLedger');
  if (production.bytecode !== '0x') throw new Error('ReliefDonationLedger must remain abstract');
  return {
    ...artifact(harnessSourceName, 'DonationLedgerHarness'),
    testOnly: true,
    productionDeployable: false,
    compiler: { version: solc.version(), evmVersion: settings.evmVersion, optimizer: settings.optimizer, viaIR: settings.viaIR },
    production,
    harness: { sourceName: harnessSourceName, contractName: 'DonationLedgerHarness', feePolicy: 'LOCAL_TEST_POLICY_ONLY' },
    testContracts: {
      registrar: artifact(harnessSourceName, 'TestContractRegistrar'),
      refundRecipient: artifact(harnessSourceName, 'TestRefundRecipient'),
    },
    warnings: (output.errors || []).filter((entry) => entry.severity !== 'error').map((entry) => entry.formattedMessage),
  };
}

module.exports = { compileDonationLedger };
