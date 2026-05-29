import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { createReadStream } from "node:fs";
import { GCodeMetadata } from "@/entities/print-job.entity";
import { convertQoiToPng } from "../bgcode/bgcode-thumbnail.parser";
import { ParsedThumbnail } from "./parser.types";

interface GCodeParseResult {
  raw: {
    _thumbnails?: ParsedThumbnail[];
    metadata: Record<string, string>;
  };
  normalized: GCodeMetadata;
}

/**
 * G-code parser for extracting metadata from .gcode files
 * Reads first and last N lines to extract slicer metadata
 */
export class GCodeParser {
  private readonly maxHeaderLinesToRead = 500; // Read from start
  private readonly maxFooterLinesToRead = 500; // Read from end

  async parse(filePath: string): Promise<GCodeParseResult> {
    const stats = await fs.stat(filePath);
    const fileName = filePath.split(/[/\\]/).pop() || filePath;

    const metadata = await this.extractMetadata(filePath);
    const thumbnails = await this.extractThumbnails(filePath);

    // Multi-tool prints (XL, MMU2/3) emit comma-separated lists for
    // per-extruder metadata: "100.5, 50.3, 30.1". parseFloat only
    // captures the first number, so without MMU detection the total
    // filament reported for a 3-tool print would be ~1/3 of reality.
    // Use the same heuristic the bgcode parser uses: if ANY of these
    // fields carries multiple comma-separated values, treat the file
    // as MMU and sum where appropriate.
    const isMmu =
      this.isMmuData(metadata.nozzle_diameter) ||
      this.isMmuData(metadata.temperature) ||
      this.isMmuData(metadata.filament_used_mm) ||
      this.isMmuData(metadata.bed_temperature) ||
      this.isMmuData(metadata.filament_type, ";");

    const normalized: GCodeMetadata = {
      fileName,
      fileFormat: "gcode",
      fileSize: stats.size,
      gcodePrintTimeSeconds: this.parseTime(
        metadata.estimated_printing_time_normal_mode || metadata.estimated_printing_time || metadata.print_time,
      ),
      nozzleDiameterMm: this.parseFirstValue(metadata.nozzle_diameter),
      filamentDiameterMm: this.parseFirstValue(metadata.filament_diameter),
      filamentDensityGramsCm3: this.parseFirstValue(metadata.filament_density),
      filamentUsedMm: this.parseFirstValue(metadata.filament_used_mm),
      filamentUsedCm3: this.parseFirstValue(metadata.filament_used_cm3),
      filamentUsedGrams: this.parseFirstValue(metadata.filament_used_g),
      // `total_filament_used_g` is sometimes present as a single sum;
      // when it's missing we have to sum the per-tool list ourselves.
      totalFilamentUsedGrams: isMmu
        ? this.sumNumberArray(this.parseNumberArray(metadata.total_filament_used_g || metadata.filament_used_g))
        : this.parseFirstValue(metadata.total_filament_used_g || metadata.filament_used_g),
      layerHeight: this.parseFloat(metadata.layer_height),
      firstLayerHeight: this.parseFloat(metadata.first_layer_height || metadata.initial_layer_height),
      bedTemperature: this.parseFirstValue(metadata.bed_temperature || metadata.first_layer_bed_temperature),
      nozzleTemperature: this.parseFirstValue(metadata.temperature || metadata.first_layer_temperature),
      fillDensity: metadata.fill_density || null,
      // PrusaSlicer separates filament_type with `;` on MMU files
      // ("PLA;PETG;ABS"). Strip into an array so downstream readers can
      // tell a single material apart from a multi-color setup; the
      // existing-string fallback covers all single-tool prints.
      filamentType: isMmu
        ? ((this.parseStringArray(metadata.filament_type, ";") as any) ?? metadata.filament_type ?? null)
        : metadata.filament_type || null,
      printerModel: metadata.printer_model || metadata.printer_name || null,
      slicerVersion: metadata.generated_by || metadata.slicer_version || null,
      maxLayerZ: this.parseFloat(metadata.max_layer_z),
      totalLayers: this.parseInt(metadata.total_layers) || this.parseInt(metadata.layer_count),
      generatedBy: metadata.generated_by,
      thumbnails:
        thumbnails.length > 0
          ? thumbnails.map((t) => ({
              width: t.width,
              height: t.height,
              format: t.format,
              dataLength: t.data?.length || 0,
            }))
          : undefined,
    };

    return {
      raw: {
        _thumbnails: thumbnails,
        metadata,
      },
      normalized,
    };
  }

  private async extractMetadata(filePath: string): Promise<Record<string, string>> {
    const metadata: Record<string, string> = {};

    // Read from start of file (header often has thumbnails and basic info)
    await this.extractMetadataFromStart(filePath, metadata);

    // Read from end of file (footer often has summary metadata - filament, time, etc.)
    await this.extractMetadataFromEnd(filePath, metadata);

    return metadata;
  }

  private async extractMetadataFromStart(filePath: string, metadata: Record<string, string>): Promise<void> {
    let linesRead = 0;

    const fileStream = createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (linesRead >= this.maxHeaderLinesToRead) break;
      linesRead++;

      this.parseMetadataLine(line, metadata);
    }

    rl.close();
    fileStream.close();
  }

  private async extractMetadataFromEnd(filePath: string, metadata: Record<string, string>): Promise<void> {
    // Read last N lines efficiently
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    // Estimate bytes to read (assume ~50 bytes per line avg)
    const estimatedBytes = this.maxFooterLinesToRead * 50;
    const startPosition = Math.max(0, fileSize - estimatedBytes);

    const fileHandle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(estimatedBytes);
      const { bytesRead } = await fileHandle.read(buffer, 0, estimatedBytes, startPosition);
      const text = buffer.toString("utf8", 0, bytesRead);
      const lines = text.split("\n");

      // Process footer lines (summary metadata often here)
      for (const line of lines) {
        this.parseMetadataLine(line, metadata);
      }
    } finally {
      await fileHandle.close();
    }
  }

  private parseMetadataLine(line: string, metadata: Record<string, string>): void {
    // Skip non-comment lines
    if (!line.startsWith(";")) return;

    // Special case: "; generated by PrusaSlicer X.X.X on ..."
    const generatedByMatch = line.match(/^;\s*generated by\s+([^\s]+)/i);
    if (generatedByMatch && !metadata.generated_by) {
      metadata.generated_by = generatedByMatch[1];
      return;
    }

    // Parse PrusaSlicer/SuperSlicer format: "; key = value"
    const prusaMatch = line.match(/^;\s*([^=]+?)\s*=\s*(.+)$/);
    if (prusaMatch) {
      let key = prusaMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
      let value = prusaMatch[2].trim();

      // Normalize bracketed units: "filament used [mm]" -> "filament_used_mm"
      key = key.replace(/\[([^\]]+)\]/g, (_, unit) => "_" + unit.replace(/\^/g, ""));
      // Normalize parentheses: "estimated printing time (normal mode)" -> "estimated_printing_time_normal_mode"
      key = key.replace(/\(([^)]+)\)/g, (_, content) => "_" + content.replace(/\s+/g, "_"));
      // Normalize multiple underscores
      key = key.replace(/_+/g, "_");

      // Don't overwrite if already set (header takes precedence)
      if (!metadata[key]) {
        metadata[key] = value.trim();
      }
      return;
    }

    // Parse Cura format: ";KEY:value"
    const curaMatch = line.match(/^;([A-Z_]+):(.+)$/);
    if (curaMatch) {
      const [, key, value] = curaMatch;
      const normalizedKey = key.toLowerCase();
      if (!metadata[normalizedKey]) {
        metadata[normalizedKey] = value.trim();
      }
      return;
    }

    // Parse Simplify3D format: "; key: value"
    const s3dMatch = line.match(/^;\s*([^:]+?):\s*(.+)$/);
    if (s3dMatch) {
      const [, key, value] = s3dMatch;
      const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, "_");
      if (!metadata[normalizedKey]) {
        metadata[normalizedKey] = value.trim();
      }
    }
  }

  private async extractThumbnails(filePath: string): Promise<ParsedThumbnail[]> {
    const thumbnails: ParsedThumbnail[] = [];
    let linesRead = 0;
    let inThumbnail = false;
    let thumbnailData: string[] = [];
    let currentWidth = 0;
    let currentHeight = 0;
    let currentFormat = "PNG";

    const fileStream = createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (linesRead >= this.maxHeaderLinesToRead && !inThumbnail) break;
      linesRead++;

      // PrusaSlicer thumbnail formats:
      //   Legacy:  ; thumbnail begin 313x173 57100      (w x h, dataLength)
      //   Legacy:  ; thumbnail begin 313x173 PNG        (w x h, format)
      //   Modern:  ; thumbnail_QOI begin 16x16 820      (format in directive, dataLength)
      //   Modern:  ; thumbnail_PNG begin 313x173 57100  (format in directive)
      // The newer PrusaSlicer (XL/MK4) writes the format as a suffix on the
      // directive name itself, with the third positional arg always being the
      // byte length. The original regex only matched the legacy form, so
      // every modern slice's thumbnails dropped on the floor and `_thumbnails`
      // came back empty — printer grid stayed blank.
      const thumbnailStart = line.match(/;\s*thumbnail(?:_(\w+))?\s+begin\s+(\d+)x(\d+)\s*(\w+)?/i);
      if (thumbnailStart) {
        inThumbnail = true;
        const directiveFormat = thumbnailStart[1]; // "QOI" / "PNG" / "JPG" / undefined
        currentWidth = parseInt(thumbnailStart[2]);
        currentHeight = parseInt(thumbnailStart[3]);

        if (directiveFormat && /^(PNG|JPG|JPEG|QOI)$/i.test(directiveFormat)) {
          // Modern: format in the directive name; third positional is length.
          currentFormat = directiveFormat.toUpperCase();
        } else {
          // Legacy: third positional could be format or byte length.
          const thirdParam = thumbnailStart[4];
          if (thirdParam && /^(PNG|JPG|JPEG|QOI)$/i.test(thirdParam)) {
            currentFormat = thirdParam.toUpperCase();
          } else {
            currentFormat = "PNG";
          }
        }

        thumbnailData = [];
        continue;
      }

      if (inThumbnail) {
        // End matches both `thumbnail end` and `thumbnail_<fmt> end`.
        if (line.match(/;\s*thumbnail(?:_\w+)?\s+end/i)) {
          let base64Data = thumbnailData.join("");
          let format = currentFormat.toUpperCase();

          if (format === "QOI") {
            try {
              const qoiBuffer = Buffer.from(base64Data, "base64");
              const pngBuffer = convertQoiToPng(qoiBuffer);
              base64Data = pngBuffer.toString("base64");
              format = "PNG";
            } catch {
              // Keep original QOI if conversion fails
            }
          }

          thumbnails.push({
            width: currentWidth,
            height: currentHeight,
            format,
            data: base64Data,
          });
          inThumbnail = false;
          thumbnailData = [];
        } else if (line.startsWith(";")) {
          const data = line.substring(1).trim();
          if (data) {
            thumbnailData.push(data);
          }
        }
      }
    }

    rl.close();
    fileStream.close();

    return thumbnails;
  }

  private parseFloat(value: string | undefined): number | null {
    if (!value) return null;
    const num = parseFloat(value);
    return isNaN(num) ? null : num;
  }

  private parseInt(value: string | undefined): number | null {
    if (!value) return null;
    const num = parseInt(value, 10);
    return isNaN(num) ? null : num;
  }

  // ── MMU / multi-tool helpers — same contract as bgcode.parser.ts ──
  // PrusaSlicer emits comma-separated lists for per-extruder values
  // on multi-tool prints (XL, MMU2/3). Plain parseFloat happily reads
  // only the first item and silently drops the rest, so we route
  // through these helpers whenever a field might be MMU.

  private parseFirstValue(value: string | undefined): number | null {
    if (!value) return null;
    const first = value.split(",")[0].trim();
    const num = parseFloat(first);
    return isNaN(num) ? null : num;
  }

  private parseNumberArray(value: string | undefined): number[] | null {
    if (!value) return null;
    const values = value
      .split(",")
      .map((v) => parseFloat(v.trim()))
      .filter((n) => !isNaN(n));
    return values.length > 0 ? values : null;
  }

  private parseStringArray(value: string | undefined, separator: string = ";"): string[] | null {
    if (!value) return null;
    const values = value
      .split(separator)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return values.length > 0 ? values : null;
  }

  private isMmuData(value: string | undefined, separator: string = ","): boolean {
    if (!value) return false;
    const parts = value
      .split(separator)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return parts.length > 1;
  }

  private sumNumberArray(values: number[] | null): number | null {
    if (!values || values.length === 0) return null;
    return values.reduce((sum, val) => sum + val, 0);
  }

  private parseTime(value: string | undefined): number | null {
    if (!value) return null;

    // Try parsing as duration string FIRST (e.g., "1d 10h 27m 13s",
    // "1h 31m 17s", or "19m 58s"). PrusaSlicer adds `Xd` once a print
    // crosses 24 hours; the old regex stopped at `h` and fell through
    // to parseFloat, which then read just the leading "1" from "1d …"
    // and returned 1 second instead of a 30+ hour estimate.
    const days = value.match(/(\d+)\s*d/i);
    const hours = value.match(/(\d+)\s*h/i);
    const minutes = value.match(/(\d+)\s*m(?!s)/i);
    const seconds = value.match(/(\d+)\s*s/i);
    if (days || hours || minutes || seconds) {
      const d = parseInt(days?.[1] ?? "0");
      const h = parseInt(hours?.[1] ?? "0");
      const m = parseInt(minutes?.[1] ?? "0");
      const s = parseInt(seconds?.[1] ?? "0");
      return d * 86400 + h * 3600 + m * 60 + s;
    }

    // Fallback to parsing as plain seconds
    const plain = parseFloat(value);
    if (!isNaN(plain)) return plain;

    return null;
  }
}
