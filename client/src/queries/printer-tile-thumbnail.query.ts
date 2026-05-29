import { useQuery } from "@tanstack/vue-query";
import { PrinterRemoteFileService } from "@/backend";
import { ComputedRef } from "vue";

export const printerTileThumbnailQueryKey = "printer-tile-thumbnail";

export const usePrinterTileThumbnailQuery = (
  printerId: ComputedRef<number | undefined>,
  enabled: boolean = true
) => {
  return useQuery({
    queryKey: [printerTileThumbnailQueryKey, printerId],
    queryFn: async () => {
      if (!printerId.value) return null;
      return PrinterRemoteFileService.getThumbnail(printerId.value);
    },
    // Defaulting to enabled — the tile gates rendering on isOnline +
    // thumbnail.length anyway, and there's no callsite today that wants to
    // suppress the fetch. The previous default `!!enabled` left the query
    // permanently disabled because no caller passed the flag, which silently
    // hid every printer's currently-printing thumbnail.
    enabled: !!printerId && enabled,
  });
};
