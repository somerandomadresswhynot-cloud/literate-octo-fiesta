declare const chrome: {
  runtime: {
    lastError?: { message: string };
    sendMessage: (message: unknown, callback: (response: any) => void) => void;
    onMessage: {
      addListener: (
        callback: (
          message: any,
          sender: any,
          sendResponse: (response: any) => void
        ) => boolean | void
      ) => void;
    };
  };
};
