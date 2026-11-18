export interface PaginationOptions<TFilter = Record<string, unknown>> {
  page?: number;
  pageSize?: number;
  search?: string;
  filters?: TFilter;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
