#include <sys/ioctl.h>
#include <termios.h>
int agmux_set_winsize(int fd, unsigned short rows, unsigned short cols) {
    struct winsize ws;
    ws.ws_row = rows; ws.ws_col = cols; ws.ws_xpixel = 0; ws.ws_ypixel = 0;
    return ioctl(fd, TIOCSWINSZ, &ws);
}
