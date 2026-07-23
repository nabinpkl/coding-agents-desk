#![cfg(target_os = "macos")]

use std::process::Command;

#[test]
fn observes_exact_child_exit_status() {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "sleep 0.05; exit 7"])
        .spawn()
        .expect("spawn child");
    let status =
        pty_manager::process_observer::observe_exit_status(child.id()).expect("observe exit");
    assert_eq!(status, 7);
    let _ = child.wait();
}

#[test]
fn observes_exact_status_after_original_parent_exits() {
    let mut pipe = [0; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let owner = unsafe { libc::fork() };
    assert!(owner >= 0);
    if owner == 0 {
        unsafe {
            libc::close(pipe[0]);
        }
        let child = unsafe { libc::fork() };
        if child == 0 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            unsafe { libc::_exit(9) };
        }
        let bytes = child.to_ne_bytes();
        let _ = unsafe { libc::write(pipe[1], bytes.as_ptr().cast(), bytes.len()) };
        unsafe { libc::_exit(0) };
    }

    unsafe {
        libc::close(pipe[1]);
    }
    let mut child_bytes = [0_u8; std::mem::size_of::<libc::pid_t>()];
    let received =
        unsafe { libc::read(pipe[0], child_bytes.as_mut_ptr().cast(), child_bytes.len()) };
    assert_eq!(received as usize, child_bytes.len());
    unsafe {
        libc::close(pipe[0]);
        libc::waitpid(owner, std::ptr::null_mut(), 0);
    }
    let child = libc::pid_t::from_ne_bytes(child_bytes);
    let status =
        pty_manager::process_observer::observe_exit_status(child as u32).expect("observe orphan");
    assert_eq!(status, 9);
}
