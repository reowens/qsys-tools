// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
// Native companion to rename-font-family.py. It preserves the Python renamer's
// sfnt/name-table rebuild behavior so that script can remain a developer-only
// parity oracle.

import Foundation

struct FontRenameError: Error, CustomStringConvertible {
    let description: String
}

struct Table {
    let tag: [UInt8]
    var data: [UInt8]
}

struct NameRecord {
    let platformID: UInt16
    let encodingID: UInt16
    let languageID: UInt16
    let nameID: UInt16
    let raw: [UInt8]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func u16(_ bytes: [UInt8], _ offset: Int) throws -> UInt16 {
    guard offset + 2 <= bytes.count else { throw FontRenameError(description: "unexpected EOF reading UInt16") }
    return (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
}

func u32(_ bytes: [UInt8], _ offset: Int) throws -> UInt32 {
    guard offset + 4 <= bytes.count else { throw FontRenameError(description: "unexpected EOF reading UInt32") }
    return (UInt32(bytes[offset]) << 24)
        | (UInt32(bytes[offset + 1]) << 16)
        | (UInt32(bytes[offset + 2]) << 8)
        | UInt32(bytes[offset + 3])
}

func appendU16(_ value: UInt16, to out: inout [UInt8]) {
    out.append(UInt8((value >> 8) & 0xff))
    out.append(UInt8(value & 0xff))
}

func appendU32(_ value: UInt32, to out: inout [UInt8]) {
    out.append(UInt8((value >> 24) & 0xff))
    out.append(UInt8((value >> 16) & 0xff))
    out.append(UInt8((value >> 8) & 0xff))
    out.append(UInt8(value & 0xff))
}

func checksum(_ input: [UInt8]) -> UInt32 {
    var data = input
    data += Array(repeating: 0, count: (4 - (data.count % 4)) % 4)

    var sum: UInt64 = 0
    var offset = 0
    while offset < data.count {
        let value = (UInt32(data[offset]) << 24)
            | (UInt32(data[offset + 1]) << 16)
            | (UInt32(data[offset + 2]) << 8)
            | UInt32(data[offset + 3])
        sum = (sum + UInt64(value)) & 0xffff_ffff
        offset += 4
    }
    return UInt32(sum)
}

func findSubsequence(_ needle: [UInt8], in haystack: [UInt8]) -> Int? {
    if needle.isEmpty { return 0 }
    if needle.count > haystack.count { return nil }
    for index in 0...(haystack.count - needle.count) {
        if Array(haystack[index ..< index + needle.count]) == needle { return index }
    }
    return nil
}

func encoding(forPlatformID platformID: UInt16) -> String.Encoding {
    platformID == 3 || platformID == 0 ? .utf16BigEndian : .isoLatin1
}

func rebuildName(_ table: [UInt8], oldName: String, newName: String) throws -> [UInt8] {
    let format = try u16(table, 0)
    let count = Int(try u16(table, 2))
    let stringOffset = Int(try u16(table, 4))

    var records: [NameRecord] = []
    for index in 0..<count {
        let recordOffset = 6 + 12 * index
        let platformID = try u16(table, recordOffset)
        let encodingID = try u16(table, recordOffset + 2)
        let languageID = try u16(table, recordOffset + 4)
        let nameID = try u16(table, recordOffset + 6)
        let length = Int(try u16(table, recordOffset + 8))
        let offset = Int(try u16(table, recordOffset + 10))
        let rawStart = stringOffset + offset
        let rawEnd = rawStart + length
        guard rawStart >= 0, rawEnd <= table.count else {
            throw FontRenameError(description: "name table record points outside string storage")
        }

        var raw = Array(table[rawStart..<rawEnd])
        let stringEncoding = encoding(forPlatformID: platformID)
        if let value = String(data: Data(raw), encoding: stringEncoding), value.contains(oldName) {
            let replacement = nameID == 6 ? newName.replacingOccurrences(of: " ", with: "") : newName
            if let encoded = value.replacingOccurrences(of: oldName, with: replacement).data(using: stringEncoding) {
                raw = Array(encoded)
            }
        }
        records.append(NameRecord(
            platformID: platformID,
            encodingID: encodingID,
            languageID: languageID,
            nameID: nameID,
            raw: raw
        ))
    }

    var storage: [UInt8] = []
    var out: [UInt8] = []
    appendU16(format, to: &out)
    appendU16(UInt16(count), to: &out)
    appendU16(UInt16(6 + 12 * count), to: &out)

    for record in records {
        var offset = findSubsequence(record.raw, in: storage)
        if offset == nil || record.raw.isEmpty {
            offset = storage.count
            storage += record.raw
        }
        appendU16(record.platformID, to: &out)
        appendU16(record.encodingID, to: &out)
        appendU16(record.languageID, to: &out)
        appendU16(record.nameID, to: &out)
        appendU16(UInt16(record.raw.count), to: &out)
        appendU16(UInt16(offset ?? 0), to: &out)
    }

    return out + storage
}

func tagString(_ tag: [UInt8]) -> String {
    String(bytes: tag, encoding: .ascii) ?? tag.map { String(format: "%02x", $0) }.joined()
}

func renameFont(_ source: [UInt8], oldName: String, newName: String) throws -> [UInt8] {
    let version = try u32(source, 0)
    let tableCount = Int(try u16(source, 4))
    let searchRange = try u16(source, 6)
    let entrySelector = try u16(source, 8)
    let rangeShift = try u16(source, 10)

    var tables: [Table] = []
    for index in 0..<tableCount {
        let recordOffset = 12 + 16 * index
        guard recordOffset + 16 <= source.count else { throw FontRenameError(description: "table directory is truncated") }
        let tag = Array(source[recordOffset ..< recordOffset + 4])
        let offset = Int(try u32(source, recordOffset + 8))
        let length = Int(try u32(source, recordOffset + 12))
        guard offset >= 0, offset + length <= source.count else {
            throw FontRenameError(description: "table \(tagString(tag)) points outside the font")
        }
        tables.append(Table(tag: tag, data: Array(source[offset ..< offset + length])))
    }

    for index in tables.indices where tables[index].tag == Array("name".utf8) {
        tables[index].data = try rebuildName(tables[index].data, oldName: oldName, newName: newName)
    }

    tables.sort { $0.tag.lexicographicallyPrecedes($1.tag) }

    var header: [UInt8] = []
    appendU32(version, to: &header)
    appendU16(UInt16(tableCount), to: &header)
    appendU16(searchRange, to: &header)
    appendU16(entrySelector, to: &header)
    appendU16(rangeShift, to: &header)

    var offset = 12 + 16 * tableCount
    var directory: [UInt8] = []
    var body: [UInt8] = []
    var headOffset: Int?

    for table in tables {
        var data = table.data
        if table.tag == Array("head".utf8) {
            guard data.count >= 12 else { throw FontRenameError(description: "head table is too short") }
            data[8] = 0
            data[9] = 0
            data[10] = 0
            data[11] = 0
            headOffset = offset
        }

        let pad = (4 - (data.count % 4)) % 4
        directory += table.tag
        appendU32(checksum(data), to: &directory)
        appendU32(UInt32(offset), to: &directory)
        appendU32(UInt32(data.count), to: &directory)
        body += data
        body += Array(repeating: 0, count: pad)
        offset += data.count + pad
    }

    var font = header + directory + body
    if let headOffset {
        let adjustment = UInt32(truncatingIfNeeded: 0xB1B0AFBA &- checksum(font))
        font[headOffset + 8] = UInt8((adjustment >> 24) & 0xff)
        font[headOffset + 9] = UInt8((adjustment >> 16) & 0xff)
        font[headOffset + 10] = UInt8((adjustment >> 8) & 0xff)
        font[headOffset + 11] = UInt8(adjustment & 0xff)
    }
    return font
}

func main() throws {
    let args = CommandLine.arguments
    guard args.count == 5 else {
        throw FontRenameError(description: "usage: \(args.first ?? "qsys-rename-font-family") <in.ttf> <out.ttf> <old-name> <new-name>")
    }

    let input = args[1]
    let output = args[2]
    let oldName = args[3]
    let newName = args[4]
    let source = Array(try Data(contentsOf: URL(fileURLWithPath: input)))
    let renamed = try renameFont(source, oldName: oldName, newName: newName)
    let outputURL = URL(fileURLWithPath: output)
    try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(renamed).write(to: outputURL)
    print("\(output): family '\(oldName)' -> '\(newName)'")
}

do {
    try main()
} catch let error as FontRenameError {
    fail(error.description)
} catch {
    fail(String(describing: error))
}
