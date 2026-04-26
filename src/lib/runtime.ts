export function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp: { ok?: boolean; error?: string } & T) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      if (!resp?.ok) {
        reject(new Error(resp?.error || 'Unknown error'));
        return;
      }
      resolve(resp);
    });
  });
}
