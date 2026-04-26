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
  tabs: {
    query: (queryInfo: { active?: boolean; currentWindow?: boolean }, callback?: (tabs: Array<{ id?: number; url?: string }>) => void) => Promise<Array<{ id?: number; url?: string }>>;
    sendMessage: (tabId: number, message: unknown, callback?: (response?: any) => void) => void;
  };
  scripting: {
    executeScript: (injection: { target: { tabId: number }; files: string[] }, callback?: (results: unknown[]) => void) => void;
  };
};
