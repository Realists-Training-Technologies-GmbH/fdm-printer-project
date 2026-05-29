export interface FileDto {
  path: string
  size: number | null
  date: number | null
  dir: boolean
  // Friendly name resolved server-side. Populated when the addressable
  // path is opaque — PrusaLink FAT 8.3 shortnames, or files that
  // PrusaHero uploaded under their `fileStorageId` UUID and whose
  // original name only exists in file-storage metadata.
  displayName?: string | null
}

export interface FilesDto {
  dirs: FileDto[]
  files: FileDto[]
}
