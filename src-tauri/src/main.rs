// Prevents an extra console window on Windows in release builds; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jeb_depot_lib::run()
}
