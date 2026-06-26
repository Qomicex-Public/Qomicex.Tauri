using System;
using System.Collections.Generic;
using System.Text;

namespace Qomicex.Launcher.Backend.PluginSDK.Models
{
    public readonly record struct PluginError
    {
        public required string Code { get; init; }
        public string? Message { get; init; }
    }
}
