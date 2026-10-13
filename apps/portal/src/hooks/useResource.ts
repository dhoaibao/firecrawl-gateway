import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Resource<T, B> {
  data: T | null;
  /** The whole response body, for siblings of `data` such as `limits`. */
  body: B | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads `GET url` (whose body is `{ data }`) on mount and again on `reload()`. */
export function useResource<T, B extends object = object>(url: string): Resource<T, B> {
  const [data, setData] = useState<T | null>(null);
  const [body, setBody] = useState<B | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .get<{ data: T } & B>(url)
      .then((json) => {
        if (!active) return;
        setData(json.data);
        setBody(json);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [url, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, body, error, loading, reload };
}
