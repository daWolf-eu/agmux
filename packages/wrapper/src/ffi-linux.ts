import { dlopen, FFIType } from "bun:ffi";

export const TIOCSWINSZ = 0x5414; // linux

// openpty is in libutil on linux; dup in libc.
export const linuxLibUtil = dlopen("libutil.so.1", {
  openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
});
export const linuxLibC = dlopen("libc.so.6", {
  dup: { args: [FFIType.int], returns: FFIType.int },
});

export const linuxLib = {
  symbols: {
    openpty: linuxLibUtil.symbols.openpty,
    dup: linuxLibC.symbols.dup,
  },
};
