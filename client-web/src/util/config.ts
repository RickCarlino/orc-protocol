import { useEffect, useState } from 'react';

const KEY = 'orcp.apiBaseUrl';

export function useApiConfig() {
  const [baseUrl, setBaseUrl] = useState<string>(() => localStorage.getItem(KEY) || 'http://localhost:3000');
  useEffect(() => { localStorage.setItem(KEY, baseUrl); }, [baseUrl]);
  return { baseUrl, setBaseUrl };
}

