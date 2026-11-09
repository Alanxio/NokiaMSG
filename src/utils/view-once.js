export function isViewOnceMessage(message) {
  const rawData = message?.rawData ?? message?._data;
  return message?.isViewOnce === true
    || message?.viewOnce === true
    || rawData?.isViewOnce === true
    || rawData?.viewOnce === true;
}
