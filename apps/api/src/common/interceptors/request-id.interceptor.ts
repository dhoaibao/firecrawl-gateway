export interface RequestWithId {
  headers: Record<string, string | string[] | undefined>;
  id?: string;
  requestId?: string;
}
