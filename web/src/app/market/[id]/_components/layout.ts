/** Desktop puts chart and content left and the trade card sticky right; mobile stacks trade card first, or chart first once resolved */
export const PAGE = "max-w-[calc(620px+3rem)] lg:max-w-[1200px]";

export const GRID = "grid gap-y-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-x-8 xl:gap-x-10";

export const CHART = "min-w-0 lg:col-start-1 lg:row-start-1";

export const SIDE = "min-w-0 scroll-mt-28 lg:sticky lg:top-(--shell-top) lg:col-start-2 lg:row-[1/span_2] lg:self-start";

export const REST = "flex min-w-0 flex-col gap-10 lg:col-start-1 lg:row-start-2";
