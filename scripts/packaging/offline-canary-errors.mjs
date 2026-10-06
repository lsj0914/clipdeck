// Error classification only. Destination hit counts and proxy controls are
// independently checked by the actual packaged method probe.
const refusalCodes = new Set([
  'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET',
  'ERR_PROXY_CONNECTION_FAILED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_EMPTY_RESPONSE', 'ERR_SOCKET_NOT_CONNECTED',
]);
const prefix = 'Error: net::';
export function isExpectedProxyRefusal(value) {
  return typeof value === 'string' && value.startsWith(prefix)
    && refusalCodes.has(value.slice(prefix.length));
}
