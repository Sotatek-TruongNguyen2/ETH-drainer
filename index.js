require('dotenv').config()

const {
  FlashbotsBundleProvider,
  FlashbotsTransactionResolution
} = require("@flashbots/ethers-provider-bundle");
const ethers = require('ethers');
var clc = require("cli-color");

const { BigNumber } = require('bignumber.js');
const { formatEther } = ethers.utils;

let RPC_INDEX = 0;

const FLASHBOT_RELAYER_CONFIGURATIONS = {
  "5": {
    chainName: "goerli",
    relayerRpc: "https://relay-goerli.flashbots.net"
  },
  "1": {
    chainName: "mainnet",
    relayerRpc: "https://relay.flashbots.net"
  }
}


const maximumAttemps = process.env.MAXIMUM_ATTEMPS;
const rpcUrls = process.env.RPC_URL.split(",");
const gasFeeMultiplier = process.env.GAS_FEE_MULTIPLIER;
const chainId = process.env.CURRENT_NETWORK_CHAIN_ID;
const flashBotEnabled = process.env.FLASHBOT_ENABLED;


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


const replaceNewRPCUrl = async () => {
  RPC_INDEX++;
  if (RPC_INDEX >= rpcUrls.length) {
    RPC_INDEX = 0;
  }
  console.log(clc.green(`Replace New RPC Url: ${clc.bold(rpcUrls[RPC_INDEX])} \n`));
  main();
}

const transferMoneyToVault = async (provider, depositWallet) => {
  const currentBalance = await provider.getBalance(depositWallet.address);

  const txFee = {};

  const feeData = await provider.getFeeData();
  const gasLimit = 50000
  // Buff gas fee by X-multiplier
  let maxGasFee = new BigNumber(gasLimit).multipliedBy(feeData.gasPrice).multipliedBy(gasFeeMultiplier);

  if (feeData.lastBaseFeePerGas && feeData.lastBaseFeePerGas.gt(0)) {
    txFee.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(gasFeeMultiplier);
    txFee.maxFeePerGas = feeData.maxFeePerGas.mul(gasFeeMultiplier);
    maxGasFee = new BigNumber(gasLimit).multipliedBy(new BigNumber(txFee.maxFeePerGas.toString()).plus(new BigNumber(txFee.maxPriorityFeePerGas.toString())));
    txFee.type = 2;
  } else {
    console.log(feeData);
    txFee.gasPrice = feeData.gasPrice.mul(gasFeeMultiplier),
      maxGasFee = new BigNumber(gasLimit).multipliedBy(new BigNumber(txFee.gasPrice.toString()));
  }

  console.log(clc.blue(`Instantiate transaction for Draining Funds from ${depositWallet.address} ...`));

  const tx = {
    to: process.env.VAULT_WALLET_ADDRESS,
    from: depositWallet.address,
    nonce: await provider.getTransactionCount(depositWallet.address),
    value: `0x${new BigNumber(currentBalance.toString()).minus(maxGasFee).toString(16)}`,
    chainId: Number(chainId),
    gasLimit: gasLimit,
    ...txFee
  }

  if (flashBotEnabled === true) {
    const { relayerRpc, chainName } = FLASHBOT_RELAYER_CONFIGURATIONS[chainId];
    const flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      depositWallet,
      relayerRpc,
      chainName
    );

    const res = await flashbotsProvider.sendPrivateTransaction({
      transaction: tx,
      signer: depositWallet
    }, {
      maxBlockNumber: await provider.getBlockNumber() + 5
    });

    const waitRes = await res.wait();

    if (waitRes === FlashbotsTransactionResolution.TransactionIncluded) {
      console.log("Private transaction successfully included on-chain.", res.transaction.hash);
    } else if (waitRes === FlashbotsTransactionResolution.TransactionDropped) {
      console.log(
        "Private transaction was not included in a block and has been removed from the system.",
      );
    }

    return;
  }

  depositWallet.sendTransaction(tx).then(
    (_receipt) => {
      console.log(clc.blue(
        `Withdrew ${clc.bold(formatEther(
          new BigNumber(currentBalance.toString()).minus(maxGasFee).toFixed()
        ))} ETH to VAULT ${clc.bold(process.env.VAULT_WALLET_ADDRESS)} ✅`,
      ))
      console.log(`Withdraw tx hash: ${_receipt.hash}`)
    },
    (reason) => {
      console.error('Withdrawal failed', reason)
    },
  )
}

const main = async () => {
  const provider = new ethers.providers.WebSocketProvider(rpcUrls[RPC_INDEX]);

  const depositWallet = new ethers.Wallet(
    process.env.DEPOSIT_WALLET_PRIVATE_KEY,
    provider,
  )

  // @check: Check if flash bot is currently using for sending private tx
  if (flashBotEnabled === false) {
    const flashBotSupportedNetworks = ["1", "5"];


    const existed = flashBotSupportedNetworks.indexOf(chainId);

    if (existed < 0) {
      console.error(`FlashBot doesn't support this network chainID. Please turn off FLASHBOT_ENABLED flag ...`);
      process.exit(0);
    }
  }

  const depositWalletAddress = depositWallet.address;
  console.log(`Watching for incoming tx to ${clc.yellow(depositWalletAddress)}…`)

  provider.on('pending', async (txHash) => {
    console.log(txHash);
    let tried = 0;
    try {
      for (let i = 0; i < maximumAttemps; i++) {
        const tx = await provider.getTransaction(txHash);
        if (tried === maximumAttemps) {
          return;
        }

        if (tx === null) {
          tried++;
          await sleep(1000);
          continue;
        }

        const { from, to, value } = tx

        if (ethers.utils.isAddress(to) && ethers.utils.getAddress(to) === ethers.utils.getAddress(depositWalletAddress)) {
          console.log(`Receiving ${formatEther(value)} ETH from ${from}…`)

          console.log(
            `Waiting for ${process.env.CONFIRMATIONS_BEFORE_WITHDRAWAL} confirmations…`,
          )

          tx.wait(process.env.CONFIRMATIONS_BEFORE_WITHDRAWAL).then(
            async (_receipt) => {
              console.log(_receipt);
              await transferMoneyToVault(provider, depositWallet);
            }
          ).catch(async err => {
            console.log(`clc.yellow('Error when waiting for tx confirmation: ${err.message}`);
            await transferMoneyToVault(provider, depositWallet);
          })

          return;
        }
      }
    } catch (err) {
      console.log(clc.red.bold(`Call RPC getTransactionReceipt failed to open due to ${clc.underline(err.message)}`));
      provider._websocket.terminate();
      replaceNewRPCUrl();
    }
  })

  provider._websocket.on('error', (err) => {
    console.log(clc.red.bold(`Websocket RPC failed to open due to ${clc.underline(err.message)}`));
    replaceNewRPCUrl();
  });

  provider._websocket.on("close", async (code) => {
    provider._websocket.terminate();
  });
}

try {
  main();
} catch (err) {
  console.log(err.message);
}