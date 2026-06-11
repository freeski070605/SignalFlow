export const strategyRegistry = [
  {
    strategy_id: 'deprecated_crypto_archive',
    strategy_name: 'deprecated_strategy_archive',
    display_name: 'Deprecated Strategy Archive',
    supported_markets: ['crypto'],
    setup_type: 'archive',
    status: 'deprecated',
    description: 'Historical comparison and failure analysis only. Archived because historical outcomes showed 22/22 would-have-lost signals.',
    required_data: ['historical signal outcomes'],
    default_settings_by_market: { crypto: { live_signal_generation_allowed: false } },
    risk_rules_by_market: { crypto: { can_generate_signals: false } }
  },
  {
    strategy_id: 'pullback_continuation_v2',
    strategy_name: 'crypto_regime_pullback_continuation_v2',
    display_name: 'Pullback Continuation V2',
    supported_markets: ['crypto', 'stocks', 'forex'],
    setup_type: 'pullback_continuation',
    status: 'active',
    status_by_market: { crypto: 'active', stocks: 'experimental', forex: 'unavailable' },
    description: 'Regime-aware pullback continuation model with calibrated confidence and conservative risk gates.',
    required_data: ['ticker', 'candles', 'volume', 'spread', 'outcomes'],
    default_settings_by_market: {},
    risk_rules_by_market: { crypto: { spot_only: true, min_rr: 1.5 }, stocks: { min_rr: 1.5 }, forex: { unavailable_until_connected: true, min_rr: 1.5 } }
  },
  { strategy_id: 'momentum_breakout', strategy_name: 'momentum_breakout', display_name: 'Momentum Breakout', supported_markets: ['crypto', 'stocks', 'forex'], setup_type: 'momentum_breakout', status: 'experimental', description: 'Experimental cross-market momentum breakout strategy.', required_data: ['ticker', 'candles', 'volume'], default_settings_by_market: {}, risk_rules_by_market: {} },
  { strategy_id: 'vwap_reclaim', strategy_name: 'vwap_reclaim', display_name: 'VWAP Reclaim', supported_markets: ['crypto', 'stocks'], setup_type: 'vwap_reclaim', status: 'experimental', description: 'Experimental VWAP reclaim strategy for markets with reliable VWAP data.', required_data: ['ticker', 'candles', 'vwap'], default_settings_by_market: {}, risk_rules_by_market: {} },
  { strategy_id: 'session_trend_continuation', strategy_name: 'session_trend_continuation', display_name: 'Session Trend Continuation', supported_markets: ['forex'], setup_type: 'session_trend_continuation', status: 'unavailable', description: 'Forex session trend model unavailable until FOREX.com real data is connected.', required_data: ['FOREX.com prices', 'session state'], default_settings_by_market: { forex: { session_filter: true } }, risk_rules_by_market: { forex: { no_leverage_by_default: true } } }
];

export function strategiesForMarket(market) {
  return strategyRegistry.filter((strategy) => strategy.supported_markets.includes(market)).map((strategy) => ({ ...strategy, status: strategy.status_by_market?.[market] || strategy.status }));
}
