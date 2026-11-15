// Platform budgets, not claims about a provider/model's advertised capacity.
export const DEFAULT_MAX_OUTPUT_TOKENS=8192;
export const MAX_OUTPUT_TOKENS=65536;
export const MODEL_TRANSFER_LIMITS=Object.freeze({requestBytes:8*1024*1024,wireBytes:64*1024*1024,eventBytes:1024*1024,bufferedBytes:2*1024*1024,relayQueueBytes:64*1024});
export function maxOutputTokens(connection){const value=connection?.maxOutputTokens;return Number.isInteger(value)&&value>=128&&value<=MAX_OUTPUT_TOKENS?value:DEFAULT_MAX_OUTPUT_TOKENS;}
