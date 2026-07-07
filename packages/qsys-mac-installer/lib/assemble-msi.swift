// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Owens
// Native companion to assemble-msi.py. It intentionally preserves the Python
// assembler's MSI table mapping behavior so that script can remain a
// developer-only parity oracle.

import Foundation

struct AssembleError: Error, CustomStringConvertible {
    let description: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func runMsiinfo(msi: String, table: String) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["msiinfo", "export", msi, table]

    let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let outURL = tmp.appendingPathComponent("qsys-msiinfo-\(UUID().uuidString).out")
    let errURL = tmp.appendingPathComponent("qsys-msiinfo-\(UUID().uuidString).err")
    FileManager.default.createFile(atPath: outURL.path, contents: nil)
    FileManager.default.createFile(atPath: errURL.path, contents: nil)
    defer {
        try? FileManager.default.removeItem(at: outURL)
        try? FileManager.default.removeItem(at: errURL)
    }

    let outHandle = try FileHandle(forWritingTo: outURL)
    let errHandle = try FileHandle(forWritingTo: errURL)
    process.standardOutput = outHandle
    process.standardError = errHandle

    try process.run()
    process.waitUntilExit()

    outHandle.closeFile()
    errHandle.closeFile()

    let out = String(data: try Data(contentsOf: outURL), encoding: .utf8) ?? ""
    let err = String(data: try Data(contentsOf: errURL), encoding: .utf8) ?? ""
    guard process.terminationStatus == 0 else {
        throw AssembleError(description: "msiinfo export \(table) failed: \(err.isEmpty ? "exit \(process.terminationStatus)" : err.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    return out.replacingOccurrences(of: "\r\n", with: "\n")
}

func msiExport(msi: String, table: String) throws -> [[String: String]] {
    let output = try runMsiinfo(msi: msi, table: table)
    let lines = output.components(separatedBy: "\n")
    guard let header = lines.first else { return [] }
    let columns = header.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
    var rows: [[String: String]] = []

    for line in lines.dropFirst(3) where !line.isEmpty {
        var values = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        if values.count < columns.count {
            values += Array(repeating: "", count: columns.count - values.count)
        }

        var row: [String: String] = [:]
        for (column, value) in zip(columns, values) {
            row[column] = value
        }
        rows.append(row)
    }
    return rows
}

func longName(_ part: String) -> String {
    if part == "." || part.isEmpty { return "" }
    guard let pipe = part.firstIndex(of: "|") else { return part }
    return String(part[part.index(after: pipe)...])
}

func splitDefaultDir(_ value: String) -> (target: String, source: String) {
    guard let colon = value.firstIndex(of: ":") else {
        let name = longName(value)
        return (name, name)
    }
    let target = String(value[..<colon])
    let source = String(value[value.index(after: colon)...])
    return (longName(target), longName(source))
}

func buildResolver(directoryRows: [[String: String]]) -> (String) -> (target: String, source: String) {
    var dirs: [String: (parent: String, target: String, source: String)] = [:]
    for row in directoryRows {
        let split = splitDefaultDir(row["DefaultDir"] ?? "")
        dirs[row["Directory"] ?? ""] = (row["Directory_Parent"] ?? "", split.target, split.source)
    }

    var memo: [String: (target: String, source: String)] = [:]
    func resolve(_ key: String) -> (target: String, source: String) {
        if let cached = memo[key] { return cached }
        guard key != "TARGETDIR", let entry = dirs[key] else {
            memo[key] = ("", "")
            return ("", "")
        }

        let target = entry.target == "SourceDir" ? "" : entry.target
        let source = entry.source == "SourceDir" ? "" : entry.source
        let parent = entry.parent.isEmpty ? ("", "") : resolve(entry.parent)
        let resolved = (
            target: parent.0 + (target.isEmpty ? "" : "/" + target),
            source: parent.1 + (source.isEmpty ? "" : "/" + source)
        )
        memo[key] = resolved
        return resolved
    }

    return resolve
}

func pathJoin(_ base: String, _ child: String) -> String {
    (base as NSString).appendingPathComponent(child)
}

func stripLeadingSlashes(_ value: String) -> String {
    var out = value
    while out.first == "/" {
        out.removeFirst()
    }
    return out
}

func basename(_ path: String) -> String {
    (path as NSString).lastPathComponent
}

func dirname(_ path: String) -> String {
    (path as NSString).deletingLastPathComponent
}

func copyFile(from source: String, to target: String) throws {
    let fm = FileManager.default
    let parent = dirname(target)
    try fm.createDirectory(atPath: parent, withIntermediateDirectories: true)
    if fm.fileExists(atPath: target) {
        try fm.removeItem(atPath: target)
    }
    try fm.copyItem(atPath: source, toPath: target)
}

func isRegularFile(_ path: String) -> Bool {
    var isDirectory = ObjCBool(false)
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
}

func main() throws {
    let args = CommandLine.arguments
    guard args.count == 4 else {
        throw AssembleError(description: "usage: assemble-msi <installer.msi> <src_root> <app_target_dir>")
    }
    let msi = args[1]
    let srcRoot = args[2]
    let app = args[3]

    let resolve = try buildResolver(directoryRows: msiExport(msi: msi, table: "Directory"))
    var componentDir: [String: String] = [:]
    for row in try msiExport(msi: msi, table: "Component") {
        componentDir[row["Component"] ?? ""] = row["Directory_"] ?? ""
    }

    var files: [(target: String, source: String)] = []
    for row in try msiExport(msi: msi, table: "File") {
        guard let directory = componentDir[row["Component_"] ?? ""] else { continue }
        let resolved = resolve(directory)
        let fileName = longName(row["FileName"] ?? "")
        let target = stripLeadingSlashes(resolved.target + (resolved.target.isEmpty ? "" : "/") + fileName)
        let source = stripLeadingSlashes(resolved.source + (resolved.source.isEmpty ? "" : "/") + fileName)
        files.append((target, source))
    }

    let libcefDir = files.first { basename($0.source).lowercased() == "libcef.dll" }.map { dirname($0.source) }
    var chosen: [String: String] = [:]
    for file in files {
        if chosen[file.target] == nil {
            chosen[file.target] = file.source
        } else if let libcefDir, dirname(file.source) == libcefDir {
            chosen[file.target] = file.source
        }
    }

    var copied = 0
    var missing: [String] = []
    for (target, source) in chosen {
        let absSource = pathJoin(srcRoot, source)
        guard isRegularFile(absSource) else {
            missing.append(source)
            continue
        }
        try copyFile(from: absSource, to: pathJoin(app, target))
        copied += 1
    }

    if !missing.isEmpty {
        let first = missing.prefix(5).joined(separator: "\n  ")
        throw AssembleError(description: "assemble-msi: \(missing.count) mapped source file(s) absent from \(srcRoot) — installer payload looks incomplete. First few:\n  \(first)")
    }

    let luax = chosen.keys.filter { $0.lowercased().hasSuffix(".luax") }.count
    guard isRegularFile(pathJoin(app, "Q-Sys Designer.exe")) else {
        throw AssembleError(description: "assemble-msi: Q-Sys Designer.exe did not land at the app root.")
    }
    guard luax > 0 else {
        throw AssembleError(description: "assemble-msi: no .luax component definitions mapped — the component layer is missing (the very bug this assembler fixes).")
    }

    print("assemble-msi: laid out \(copied) files (\(luax) .luax component defs).")
}

do {
    try main()
} catch let error as AssembleError {
    fail(error.description)
} catch {
    fail(String(describing: error))
}
