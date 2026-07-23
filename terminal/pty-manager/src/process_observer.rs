use std::io;
use std::mem;
use std::os::fd::{FromRawFd, OwnedFd};
use std::ptr;

pub fn observe_exit_status(pid: u32) -> io::Result<i32> {
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return Err(io::Error::last_os_error());
    }
    let queue = unsafe { OwnedFd::from_raw_fd(queue) };
    let change = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT | libc::NOTE_EXITSTATUS,
        data: 0,
        udata: ptr::null_mut(),
    };
    let registered = unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            &change,
            1,
            ptr::null_mut(),
            0,
            ptr::null(),
        )
    };
    if registered < 0 {
        return Err(io::Error::last_os_error());
    }

    let mut event: libc::kevent = unsafe { mem::zeroed() };
    let received = unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            ptr::null(),
            0,
            &mut event,
            1,
            ptr::null(),
        )
    };
    if received < 0 {
        return Err(io::Error::last_os_error());
    }
    if received != 1 || event.fflags & libc::NOTE_EXIT == 0 {
        return Err(io::Error::other("process exit event missing"));
    }
    Ok(decode_wait_status(event.data as i32))
}

fn decode_wait_status(status: i32) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        128 + libc::WTERMSIG(status)
    }
}

use std::os::fd::AsRawFd;
