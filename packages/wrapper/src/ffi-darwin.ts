import { dlopen, FFIType } from "bun:ffi";

export const TIOCSWINSZ = 0x80087467; // darwin

export const darwinLib = dlopen("libSystem.dylib", {
  // int openpty(int *amaster, int *aslave, char *name, struct termios *termp, struct winsize *winp);
  openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  dup: { args: [FFIType.int], returns: FFIType.int },
});
