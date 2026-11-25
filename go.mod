// Marks the repository root as a Go main module so that `go tool -modfile=tools/go.mod
// <tool>` (oasdiff, apidiff, scc) also runs from the root: with -modfile, Go still needs
// a go.mod in the working directory or above it to find the module root. It declares
// no packages or dependencies; the tools and their versions live in tools/go.mod.
module github.com/CesarManzoCode/paridad

go 1.27.4
