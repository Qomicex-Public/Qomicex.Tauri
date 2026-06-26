using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.PluginSDK.Models;
using System;
using System.Collections.Generic;
using System.Text;

namespace Qomicex.Launcher.Backend.PluginSDK.Interfaces
{
    public interface IPlugin
    {
        string Id { get; }
        string Name { get; }
        Version Version { get; }
        string Description { get; }
        bool IsEnabled { get; set; }

        Task<Result<bool, PluginError>> InitializeAsync(IServiceProvider services);
        Task<Result<bool, PluginError>> ShutdownAsync();
    }
}
