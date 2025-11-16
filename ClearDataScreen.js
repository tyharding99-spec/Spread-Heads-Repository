import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ClearDataScreen = ({ navigation }) => {
    useEffect(() => {
        const clearData = async () => {
            try {
                await AsyncStorage.clear();
                console.log('Successfully cleared all data');
                // Navigate back to the main screen or login screen
                navigation.replace('Login');
            } catch (error) {
                console.error('Error clearing data:', error);
            }
        };

        clearData();
    }, []);

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text>Clearing data...</Text>
        </View>
    );
};