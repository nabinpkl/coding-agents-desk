import AppKit

let configuration = SpikeConfiguration(arguments: CommandLine.arguments)
let application = NSApplication.shared
let applicationDelegate = SpikeApplicationDelegate(configuration: configuration)
application.setActivationPolicy(.accessory)
application.delegate = applicationDelegate
application.run()
