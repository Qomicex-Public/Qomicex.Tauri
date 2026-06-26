using System;
using System.Collections.Generic;
using System.Text;

namespace Qomicex.Launcher.Backend.PluginSDK.Attributes
{
    [AttributeUsage(AttributeTargets.Class, Inherited = false)]
    public sealed class PluginAttribute : Attribute
    {
        public string Id { get; }
        public string Name { get; }
        public string Version { get; }
        public string Description { get; } = string.Empty;

        public PluginAttribute(string id, string name, string version)
        {
            Id = id;
            Name = name;
            Version = version;
        }
    }
}
