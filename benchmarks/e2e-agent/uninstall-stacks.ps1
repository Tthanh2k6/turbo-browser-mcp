$ErrorActionPreference = 'Stop'
$target = 'D:\dev\bench-tmp'
if (Test-Path -LiteralPath $target) {
    $resolved = (Resolve-Path -LiteralPath $target).Path.TrimEnd('\')
    if ($resolved -ine 'D:\dev\bench-tmp') { throw "Unexpected uninstall target: $resolved" }
    if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected install root' }
    # Refuse junctions/symlinks inside the tree too; do not risk traversing outside it.
    $links = Get-ChildItem -LiteralPath $target -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    if ($links) { throw 'Remove reparse points before uninstalling' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
