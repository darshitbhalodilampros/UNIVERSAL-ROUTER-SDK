import JSBI from 'jsbi'
import { RoutePlanner, CommandType } from '../../utils/routerCommands'
// import { Trade as V1Trade, Pair } from '@pollum-io/v1-sdk'
import { Trade as V2Trade, Pool, encodeRouteToPath } from 'lampros-v3'
import {
  Trade as RouterTrade,
  // MixedRouteTrade,
  Protocol,
  IRoute,
  RouteV2,
  // MixedRouteSDK,
  SwapOptions as RouterSwapOptions,
  // getOutputOfPools,
  // encodeMixedRouteToPath,
  // partitionMixedRouteByProtocol,
} from 'lampros-router'
import { Permit2Permit } from '../../utils/inputTokens'
import { Currency, TradeType, CurrencyAmount, Percent } from 'lampros-core'
import { Command, RouterTradeType, TradeConfig } from '../Command'
import { SENDER_AS_RECIPIENT, ROUTER_AS_RECIPIENT } from '../../utils/constants'
import { encodeFeeBips } from '../../utils/expandTo18Decimals'
import { BigNumber, BigNumberish } from 'ethers'

export type FlatFeeOptions = {
  amount: BigNumberish
  recipient: string
}
// the existing router permit object doesn't include enough data for permit2
// so we extend swap options with the permit2 permit
export type SwapOptions = Omit<RouterSwapOptions, 'inputTokenPermit'> & {
  inputTokenPermit?: Permit2Permit,
  flatFee?: FlatFeeOptions
}

const REFUND_ETH_PRICE_IMPACT_THRESHOLD = new Percent(JSBI.BigInt(50), JSBI.BigInt(100))

interface Swap<TInput extends Currency, TOutput extends Currency> {
  route: IRoute<TInput, TOutput, Pool>
  inputAmount: CurrencyAmount<TInput>
  outputAmount: CurrencyAmount<TOutput>
}

// Wrapper for pegasys router-sdk trade entity to encode swaps for Universal Router
// also translates trade objects from previous (v2, v3) SDKs
export class PegasysTrade implements Command {
  readonly tradeType: RouterTradeType = RouterTradeType.PegasysTrade
  constructor(public trade: RouterTrade<Currency, Currency, TradeType>, public options: SwapOptions) {
    if (!!options.fee && !!options.flatFee) throw new Error('Only one fee option permitted')
   }

  encode(planner: RoutePlanner, _config: TradeConfig): void {
    let payerIsUser = true
    if (this.trade.inputAmount.currency.isNative) {
      // TODO: optimize if only one v2 pool we can directly send this to the pool
      planner.addCommand(CommandType.WRAP_ETH, [
        ROUTER_AS_RECIPIENT,
        this.trade.maximumAmountIn(this.options.slippageTolerance).quotient.toString(),
      ])
      // since WETH is now owned by the router, the router pays for inputs
      payerIsUser = false
    }
    this.options.recipient = this.options.recipient ?? SENDER_AS_RECIPIENT

    // flag for whether we want to perform slippage check on aggregate output of multiple routes
    //   1. when there are >2 exact input trades. this is only a heuristic,
    //      as it's still more gas-expensive even in this case, but has benefits
    //      in that the reversion probability is lower
    const performAggregatedSlippageCheck =
      this.trade.tradeType === TradeType.EXACT_INPUT && this.trade.routes.length > 2
    const outputIsNative = this.trade.outputAmount.currency.isNative
    const inputIsNative = this.trade.inputAmount.currency.isNative
    const routerMustCustody = performAggregatedSlippageCheck || outputIsNative || hasFeeOption(this.options)

    for (const swap of this.trade.swaps) {
      switch (swap.route.protocol) {
        // case Protocol.V1:
        //   addV2Swap(planner, swap, this.trade.tradeType, this.options, payerIsUser, routerMustCustody)
        //   break
        case Protocol.V3:
          addV3Swap(planner, swap, this.trade.tradeType, this.options, payerIsUser, routerMustCustody)
          break
        // case Protocol.MIXED:
        //   addMixedSwap(planner, swap, this.trade.tradeType, this.options, payerIsUser, routerMustCustody)
        //   break
        default:
          throw new Error('UNSUPPORTED_TRADE_PROTOCOL')
      }
    }
    
    let minimumAmountOut: BigNumber = BigNumber.from(
      this.trade.minimumAmountOut(this.options.slippageTolerance).quotient.toString()
    )

    if (routerMustCustody) {
      if (!!this.options.fee) {
        const feeBips = encodeFeeBips(this.options.fee.fee)
        planner.addCommand(CommandType.PAY_PORTION, [
          this.trade.outputAmount.currency.wrapped.address,
          this.options.fee.recipient,
          feeBips,
        ])

        // If the trade is exact output, and a fee was taken, we must adjust the amount out to be the amount after the fee
        // Otherwise we continue as expected with the trade's normal expected output
        if (this.trade.tradeType === TradeType.EXACT_OUTPUT) {
          minimumAmountOut = minimumAmountOut.sub(minimumAmountOut.mul(feeBips).div(10000))
        }
      }

      if (!!this.options.flatFee) {
        const feeAmount = this.options.flatFee.amount
        if (minimumAmountOut.lt(feeAmount)) throw new Error('Flat fee amount greater than minimumAmountOut')

        planner.addCommand(CommandType.TRANSFER, [
          this.trade.outputAmount.currency.wrapped.address,
          this.options.flatFee.recipient,
          feeAmount,
        ])

        // If the trade is exact output, and a fee was taken, we must adjust the amount out to be the amount after the fee
        // Otherwise we continue as expected with the trade's normal expected output
        if (this.trade.tradeType === TradeType.EXACT_OUTPUT) {
          minimumAmountOut = minimumAmountOut.sub(feeAmount)
        }
      }

      if (outputIsNative) {
        planner.addCommand(CommandType.UNWRAP_WETH, [this.options.recipient, minimumAmountOut])
      } else {
        planner.addCommand(CommandType.SWEEP, [
          this.trade.outputAmount.currency.wrapped.address,
          this.options.recipient,
          minimumAmountOut,
        ])
      }
    }

    if (inputIsNative && (this.trade.tradeType === TradeType.EXACT_OUTPUT || riskOfPartialFill(this.trade))) {
      // for exactOutput swaps that take native currency as input
      // we need to send back the change to the user
      planner.addCommand(CommandType.UNWRAP_WETH, [this.options.recipient, 0])
    }
  }
}

// encode a Pegasys v2 swap
// function addV2Swap<TInput extends Currency, TOutput extends Currency>(
//   planner: RoutePlanner,
//   { route, inputAmount, outputAmount }: Swap<TInput, TOutput>,
//   tradeType: TradeType,
//   options: SwapOptions,
//   payerIsUser: boolean,
//   routerMustCustody: boolean
// ): void {
//   const trade = new V1Trade(
//     route as RouteV1<TInput, TOutput>,
//     tradeType == TradeType.EXACT_INPUT ? inputAmount : outputAmount,
//     tradeType
//   )

//   if (tradeType == TradeType.EXACT_INPUT) {
//     planner.addCommand(CommandType.V1_SWAP_EXACT_IN, [
//       // if native, we have to unwrap so keep in the router for now
//       routerMustCustody ? ROUTER_AS_RECIPIENT : options.recipient,
//       trade.maximumAmountIn(options.slippageTolerance).quotient.toString(),
//       trade.minimumAmountOut(options.slippageTolerance).quotient.toString(),
//       route.path.map((pool) => pool.address),
//       payerIsUser,
//     ])
//   } else if (tradeType == TradeType.EXACT_OUTPUT) {
//     planner.addCommand(CommandType.V1_SWAP_EXACT_OUT, [
//       routerMustCustody ? ROUTER_AS_RECIPIENT : options.recipient,
//       trade.minimumAmountOut(options.slippageTolerance).quotient.toString(),
//       trade.maximumAmountIn(options.slippageTolerance).quotient.toString(),
//       route.path.map((pool) => pool.address),
//       payerIsUser,
//     ])
//   }
// }

// encode a Pegasys v3 swap
function addV3Swap<TInput extends Currency, TOutput extends Currency>(
  planner: RoutePlanner,
  { route, inputAmount, outputAmount }: Swap<TInput, TOutput>,
  tradeType: TradeType,
  options: SwapOptions,
  payerIsUser: boolean,
  routerMustCustody: boolean
): void {
  const trade = V2Trade.createUncheckedTrade({
    route: route as RouteV2<TInput, TOutput>,
    inputAmount,
    outputAmount,
    tradeType,
  })

  const path = encodeRouteToPath(route as RouteV2<TInput, TOutput>, trade.tradeType === TradeType.EXACT_OUTPUT)
  if (tradeType == TradeType.EXACT_INPUT) {
    planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [
      routerMustCustody ? ROUTER_AS_RECIPIENT : options.recipient,
      trade.maximumAmountIn(options.slippageTolerance).quotient.toString(),
      trade.minimumAmountOut(options.slippageTolerance).quotient.toString(),
      path,
      payerIsUser,
    ])
  } else if (tradeType == TradeType.EXACT_OUTPUT) {
    planner.addCommand(CommandType.V2_SWAP_EXACT_OUT, [
      routerMustCustody ? ROUTER_AS_RECIPIENT : options.recipient,
      trade.minimumAmountOut(options.slippageTolerance).quotient.toString(),
      trade.maximumAmountIn(options.slippageTolerance).quotient.toString(),
      path,
      payerIsUser,
    ])
  }
}

// encode a mixed route swap, i.e. including both v2 and v3 pools
// function addMixedSwap<TInput extends Currency, TOutput extends Currency>(
//   planner: RoutePlanner,
//   swap: Swap<TInput, TOutput>,
//   tradeType: TradeType,
//   options: SwapOptions,
//   payerIsUser: boolean,
//   routerMustCustody: boolean
// ): void {
//   const { route, inputAmount, outputAmount } = swap
//   const tradeRecipient = routerMustCustody ? ROUTER_AS_RECIPIENT : options.recipient

//   // single hop, so it can be reduced to plain v2 or v3 swap logic
//   if (route.pools.length === 1) {
//     if (route.pools[0] instanceof Pool) {
//       return addV3Swap(planner, swap, tradeType, options, payerIsUser, routerMustCustody)
//     } else if (route.pools[0] instanceof Pair) {
//       return addV2Swap(planner, swap, tradeType, options, payerIsUser, routerMustCustody)
//     } else {
//       throw new Error('Invalid route type')
//     }
//   }

//   const trade = MixedRouteTrade.createUncheckedTrade({
//     route: route as MixedRoute<TInput, TOutput>,
//     inputAmount,
//     outputAmount,
//     tradeType,
//   })

//   const amountIn = trade.maximumAmountIn(options.slippageTolerance, inputAmount).quotient.toString()
//   const amountOut = trade.minimumAmountOut(options.slippageTolerance, outputAmount).quotient.toString()

//   // logic from
//   // https://github.com/Uniswap/router-sdk/blob/d8eed164e6c79519983844ca8b6a3fc24ebcb8f8/src/swapRouter.ts#L276
//   const sections = partitionMixedRouteByProtocol(route as MixedRoute<TInput, TOutput>)
//   const isLastSectionInRoute = (i: number) => {
//     return i === sections.length - 1
//   }

//   let outputToken
//   let inputToken = route.input.wrapped

//   for (let i = 0; i < sections.length; i++) {
//     const section = sections[i]
//     /// Now, we get output of this section
//     outputToken = getOutputOfPools(section, inputToken)

//     const newRouteOriginal = new MixedRouteSDK(
//       [...section],
//       section[0].token0.equals(inputToken) ? section[0].token0 : section[0].token1,
//       outputToken
//     )
//     const newRoute = new MixedRoute(newRouteOriginal)

//     /// Previous output is now input
//     inputToken = outputToken

//     const mixedRouteIsAllV3 = (route: MixedRouteSDK<Currency, Currency>) => {
//       return route.pools.every((pool) => pool instanceof Pool)
//     }

//     if (mixedRouteIsAllV3(newRoute)) {
//       const path: string = encodeMixedRouteToPath(newRoute)

//       planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [
//         // if not last section: send tokens directly to the first v2 pair of the next section
//         // note: because of the partitioning function we can be sure that the next section is v2
//         isLastSectionInRoute(i) ? tradeRecipient : (sections[i + 1][0] as Pair).liquidityToken.address,
//         i == 0 ? amountIn : CONTRACT_BALANCE, // amountIn
//         !isLastSectionInRoute(i) ? 0 : amountOut, // amountOut
//         path, // path
//         payerIsUser && i === 0, // payerIsUser
//       ])
//     } else {
//       planner.addCommand(CommandType.V1_SWAP_EXACT_IN, [
//         isLastSectionInRoute(i) ? tradeRecipient : ROUTER_AS_RECIPIENT, // recipient
//         i === 0 ? amountIn : CONTRACT_BALANCE, // amountIn
//         !isLastSectionInRoute(i) ? 0 : amountOut, // amountOutMin
//         newRoute.path.map((pool) => pool.address), // path
//         payerIsUser && i === 0,
//       ])
//     }
//   }
// }

// if price impact is very high, there's a chance of hitting max/min prices resulting in a partial fill of the swap
function riskOfPartialFill(trade: RouterTrade<Currency, Currency, TradeType>): boolean {
  return trade.priceImpact.greaterThan(REFUND_ETH_PRICE_IMPACT_THRESHOLD)
}

function hasFeeOption(swapOptions: SwapOptions): boolean {
  return !!swapOptions.fee || !!swapOptions.flatFee
}