using System;
using System.Collections.Generic;
using System.Text;

namespace Qomicex.Core
{
    public class DataModules
    {
        public class DataDetails
        {
            public class Account
            {
                public string Name = string.Empty;
                public string Uuid = string.Empty;
                public string Token = string.Empty;
                public string AccessToken = "faked-token-for-offline";
                public string RefreshToken = string.Empty;
                public string LoginMethod = "Legacy";
            }
            public class Java
            {
                public string Name { get; set; } = string.Empty;
                public string Path { get; set; } = string.Empty;
                public string Version { get; set; } = string.Empty;
                public int VersionID { get; set; } = 0;
                public string Type { get; set; } = string.Empty;
                public string Arch { get; set; } = string.Empty;
            }
            public class Launcher
            {
                public Account Account = new Account();
                public Java Java = new Java();
                public class WindowSize
                {
                    public string Width = "854";
                    public string height = "480";
                }
                public bool DevideVersion = false;
                public string AdditionalParam = string.Empty;
                public string Version = string.Empty;
                public string MaxMemory = string.Empty;

            }
            public class Version
            {
                private string _name = string.Empty;

                public Version(string gameDir = "")
                {
                    GameDir = gameDir;
                }
                public string GameDir = string.Empty;
                public string Name
                {
                    get => _name;
                    set
                    {
                        _name = value;
                        VersionDir = Path.Combine(GameDir, "versions", _name); //$"{GameDir}/versions/{_name}"
                        GameVersion = _name;
                        Modules.Helpers.GeneralHelper helper = new Modules.Helpers.GeneralHelper();
                        if (GameDir != string.Empty)
                        {
                            Type = helper.GetModLoaderType(_name, GameDir);
                            var state = helper.CheckVersionAvailablity(GameDir, _name);
                            State = state.Name;
                            StateDescribe = state.Describe;
                        }
                        else
                        {
                            Type = new List<LoaderInfo>();
                        }
                    }
                }
                public List<LoaderInfo> Type = new List<LoaderInfo>();
                public string GameVersion = string.Empty;
                public string VersionDir = string.Empty;
                public string State = "Available";
                public string StateDescribe = "Everything is OK";
            }
        }

        public struct State
        {
            public string Name = "Available";
            public string Describe = "Everything is OK";
            public int Code = 0;

            public State()
            {
            }

            public enum StateCode
            {
                Available = 0,
                MissingFiles = 1,
                WrongId = 2,
                Unknown = 3
            }
        }

        public struct SystemInfo
        {
            public string OS = string.Empty;
            public string OSVersion = string.Empty;
            public string OSName = string.Empty;
            public string Architecture = string.Empty;
            public string OSVersionID = string.Empty;
            public string OSDisplayName = string.Empty;

            public SystemInfo()
            {
            }
        }

        public struct LoaderInfo
        {
            public LoaderInfo() { }
            public LoaderInfo(string type, string version) { Type = type; Version = version; }
            public string Type = string.Empty;
            public string Version = string.Empty;
        }
    }

}
