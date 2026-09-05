'use strict';

const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const root = path.resolve(__dirname, '../..');
const sourceName = 'contracts/ReliefPool.sol';
const artifactPath = path.join(root, 'web/shared/contracts/ReliefPool.json');

function findImports(importPath) {
  if (!importPath.startsWith('@openzeppelin/contracts/') || importPath.includes('..')) {
    return { error: `Unsupported import: ${importPath}` };
  }
  try {
    return { contents: fs.readFileSync(require.resolve(importPath), 'utf8') };
  } catch (error) {
    return { error: error.message };
  }
}

function compileContract({ write = true } = {}) {
  const input = {
    language: 'Solidity',
    sources: { [sourceName]: { content: fs.readFileSync(path.join(root, sourceName), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  for (const diagnostic of output.errors || []) {
    if (diagnostic.severity !== 'error') console.warn(diagnostic.formattedMessage);
  }
  const errors = (output.errors || []).filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'));
  const compiled = output.contracts[sourceName].ReliefPool;
  if (Object.keys(compiled.evm.deployedBytecode.immutableReferences || {}).length) {
    throw new Error('ReliefPool must not contain immutable references');
  }
  for (const bytecode of [compiled.evm.bytecode, compiled.evm.deployedBytecode]) {
    if (Object.keys(bytecode.linkReferences || {}).length) throw new Error('Unresolved library links');
  }
  const artifact = {
    contractName: 'ReliefPool',
    sourceName,
    compiler: { version: solc.version(), evmVersion: 'paris', optimizer: input.settings.optimizer },
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    metadata: JSON.parse(compiled.metadata),
  };
  if (write) {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  return artifact;
}

if (require.main === module) {
  try {
    const artifact = compileContract();
    console.log(`Compiled ${artifact.contractName} with solc ${artifact.compiler.version} (paris)`);
    console.log(`Artifact: ${artifactPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { compileContract, findImports, artifactPath };
