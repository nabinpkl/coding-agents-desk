fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    std::env::set_var("PROTOC", protoc);

    prost_build::compile_protos(&["proto/pty.proto", "proto/vault.proto"], &["proto"])?;

    println!("cargo:rerun-if-changed=proto/pty.proto");
    println!("cargo:rerun-if-changed=proto/vault.proto");
    Ok(())
}
